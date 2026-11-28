import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { NotificationCenter } from "./components/NotificationCenter.tsx";
import { api, subscribeToEvents } from "./lib/api.ts";
import { pageLoaders } from "./lib/route-loaders.ts";
import type { EventEnvelope, TaskView } from "./lib/types.ts";
import { ChatPage } from "./pages/ChatPage.tsx";

const ConnectionsPage = lazy(() => pageLoaders.connections().then((module) => ({ default: module.ConnectionsPage })));
const LibraryPage = lazy(() => pageLoaders.library().then((module) => ({ default: module.LibraryPage })));
const OnboardingPage = lazy(() => pageLoaders.onboarding().then((module) => ({ default: module.OnboardingPage })));
const SettingsPage = lazy(() => pageLoaders.settings().then((module) => ({ default: module.SettingsPage })));
const SchedulesPage = lazy(() => pageLoaders.schedules().then((module) => ({ default: module.SchedulesPage })));
const EvidencePage = lazy(() => pageLoaders.evidence().then((module) => ({ default: module.EvidencePage })));

export default function App() {
  return (
    <>
      <EventBridge />
      <NotificationCenter />
      <FirstRunGate>
        <Routes>
          <Route path="welcome" element={<Suspended><OnboardingPage /></Suspended>} />
          <Route element={<AppShell />}>
            <Route index element={<ChatPage />} />
            <Route path="tasks" element={<Navigate to="/" replace />} />
            <Route path="tasks/:id" element={<Navigate to="/" replace />} />
            <Route path="inbox" element={<Navigate to="/" replace />} />
            <Route path="knowledge" element={<Navigate to="/library" replace />} />
            <Route path="memory" element={<Navigate to="/library" replace />} />
            <Route path="library" element={<Suspended><LibraryPage /></Suspended>} />
            <Route path="context" element={<Navigate to="/library?handoff=1" replace />} />
            <Route path="dossier" element={<Navigate to="/settings?tab=dossier" replace />} />
            <Route path="schedules" element={<Suspended><SchedulesPage /></Suspended>} />
            <Route path="evidence" element={<Suspended><EvidencePage /></Suspended>} />
            <Route path="connections" element={<Suspended><ConnectionsPage /></Suspended>} />
            <Route path="settings" element={<Suspended><SettingsPage /></Suspended>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </FirstRunGate>
    </>
  );
}

function Suspended({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageLoading />}>{children}</Suspense>;
}

function PageLoading() {
  return (
    <div className="page-loading" role="status" aria-live="polite">
      <span className="page-loading-mark" aria-hidden="true" />
      <span>正在打开…</span>
    </div>
  );
}

function FirstRunGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const onboardingQuery = useQuery({
    queryKey: ["onboarding"],
    queryFn: api.onboarding,
    staleTime: 10_000
  });
  if (location.pathname === "/" && onboardingQuery.data?.required) {
    return <Navigate to="/welcome" replace />;
  }
  return <>{children}</>;
}

function EventBridge() {
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const routedTaskId = pathname.startsWith("/tasks/") ? decodeURIComponent(pathname.slice("/tasks/".length)) : null;

  useEffect(() => {
    const taskRefreshTimers = new Map<string, number>();
    const pendingTaskProgress = new Map<string, EventEnvelope[]>();
    const taskProgressTimers = new Map<string, number>();
    const flushTaskProgress = (taskId: string) => {
      taskProgressTimers.delete(taskId);
      const pending = pendingTaskProgress.get(taskId) ?? [];
      pendingTaskProgress.delete(taskId);
      if (pending.length === 0) return;
      queryClient.setQueryData<TaskView>(["task", taskId], (current) => {
        if (!current) return current;
        const known = new Set(current.events.map((item) => item.id));
        const additions = pending.filter((item) => !known.has(item.id));
        if (additions.length === 0) return current;
        return {
          ...current,
          events: [...current.events, ...additions].slice(-200),
          eventTotal: current.eventTotal + additions.length
        };
      });
    };
    const appendTaskProgress = (envelope: EventEnvelope | undefined) => {
      if (!envelope?.taskId || envelope.type !== "task.progress") return;
      const pending = pendingTaskProgress.get(envelope.taskId) ?? [];
      if (pending.some((item) => item.id === envelope.id)) return;
      pending.push(envelope);
      pendingTaskProgress.set(envelope.taskId, pending);
      if (taskProgressTimers.has(envelope.taskId)) return;
      // Progress events can arrive in bursts. Render one coalesced update per
      // animation-sized interval instead of causing a React tree update per line.
      taskProgressTimers.set(envelope.taskId, window.setTimeout(() => {
        flushTaskProgress(envelope.taskId as string);
      }, 96));
    };
    const scheduleTaskRefresh = (taskId: string | null, delay = 160) => {
      if (!taskId) return;
      const current = taskRefreshTimers.get(taskId);
      if (current !== undefined) window.clearTimeout(current);
      taskRefreshTimers.set(taskId, window.setTimeout(() => {
        taskRefreshTimers.delete(taskId);
        void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      }, delay));
    };
    const invalidateTask = (taskId: string | null, immediate = false) => {
      if (!taskId) return;
      if (immediate) {
        void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
      } else {
        scheduleTaskRefresh(taskId);
      }
    };

    const unsubscribe = subscribeToEvents((event, envelope) => {
      const eventTaskId = envelope?.taskId ?? routedTaskId;
      appendTaskProgress(envelope);

      if (event === "task.progress") return;

      if (event === "task.created" || event === "task.updated") {
        invalidateTask(eventTaskId, true);
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
        return;
      }
      if (event === "task.follow-up.created" || event === "task.follow-up.updated" || event === "run.created" || event === "run.updated") {
        invalidateTask(eventTaskId);
        return;
      }
      if (event === "approval.created" || event === "approval.updated") {
        invalidateTask(eventTaskId);
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        return;
      }
      if (event === "artifact.published" || event.startsWith("effect.")) {
        invalidateTask(eventTaskId);
        if (event === "artifact.published") {
          void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
          void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        }
        return;
      }
      if (event.startsWith("plan.")) {
        void queryClient.invalidateQueries({ queryKey: ["plans"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        return;
      }
      if (["chat.message.created", "chat.message.updated", "message"].includes(event)) {        void queryClient.invalidateQueries({ queryKey: ["conversations"] });
        void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        return;
      }
      if (event.startsWith("goal.")) {
        void queryClient.invalidateQueries({ queryKey: ["goals"] });
        void queryClient.invalidateQueries({ queryKey: ["goal"] });
        if (eventTaskId) invalidateTask(eventTaskId);
        return;
      }
      if (event === "tool.job.updated") {
        void queryClient.invalidateQueries({ queryKey: ["background-tools"] });
        invalidateTask(eventTaskId);
        return;
      }
      if (event.startsWith("source.")) {
        void queryClient.invalidateQueries({ queryKey: ["sources"] });
        return;
      }
      if (event.startsWith("memory.") || event === "context.item.appended" || event === "context.summary.updated" || event === "context.settings.updated" || event === "context.task.deleted") {
        void queryClient.invalidateQueries({ queryKey: ["memory"] });
        void queryClient.invalidateQueries({ queryKey: ["context"] });
        void queryClient.invalidateQueries({ queryKey: ["library-status"] });
        void queryClient.invalidateQueries({ queryKey: ["library-tree"] });
        return;
      }
      if (event === "schedule.created" || event === "schedule.updated" || event === "schedule.run.created" || event === "schedule.run.updated") {
        void queryClient.invalidateQueries({ queryKey: ["schedules"] });
        void queryClient.invalidateQueries({ queryKey: ["scheduleRuns"] });
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        return;
      }
      if (event === "security.kill-switch.updated" || event === "security.audit") {
        void queryClient.invalidateQueries({ queryKey: ["security"] });
        void queryClient.invalidateQueries({ queryKey: ["system"] });
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        return;
      }
      if (event.startsWith("device.") || event.startsWith("desktop.")) {
        void queryClient.invalidateQueries({ queryKey: ["devices"] });
        void queryClient.invalidateQueries({ queryKey: ["desktop"] });
        return;
      }
      if (event.startsWith("execution.")) {
        invalidateTask(eventTaskId);
        void queryClient.invalidateQueries({ queryKey: ["diagnostics"] });
      }
    });
    return () => {
      for (const timer of taskRefreshTimers.values()) window.clearTimeout(timer);
      for (const timer of taskProgressTimers.values()) window.clearTimeout(timer);
      taskRefreshTimers.clear();
      taskProgressTimers.clear();
      pendingTaskProgress.clear();
      unsubscribe();
    };
  }, [queryClient, routedTaskId]);

  return null;
}
