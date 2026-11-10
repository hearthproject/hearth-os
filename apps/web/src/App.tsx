import { useEffect, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { NotificationCenter } from "./components/NotificationCenter.tsx";
import { api, subscribeToEvents } from "./lib/api.ts";
import { ChatPage } from "./pages/ChatPage.tsx";
import { DevicesPage } from "./pages/DevicesPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { MailPage } from "./pages/MailPage.tsx";
import { OnboardingPage } from "./pages/OnboardingPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SchedulesPage } from "./pages/SchedulesPage.tsx";
import { TaskDetailPage } from "./pages/TaskDetailPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";

export default function App() {
  return (
    <>
      <EventBridge />
      <NotificationCenter />
      <FirstRunGate>
        <Routes>
          <Route path="welcome" element={<OnboardingPage />} />
          <Route element={<AppShell />}>
            <Route index element={<ChatPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="tasks/:id" element={<TaskDetailPage />} />
            <Route path="inbox" element={<InboxPage />} />
            <Route path="memory" element={<Navigate to="/settings?tab=automation" replace />} />
            <Route path="mail" element={<MailPage />} />
            <Route path="methods" element={<Navigate to="/settings?tab=automation" replace />} />
            <Route path="schedules" element={<SchedulesPage />} />
            <Route path="devices" element={<DevicesPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </FirstRunGate>
    </>
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
  const taskId = pathname.startsWith("/tasks/") ? decodeURIComponent(pathname.slice("/tasks/".length)) : null;

  useEffect(() => {
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeToEvents((event) => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["health"] });
        void queryClient.invalidateQueries({ queryKey: ["system"] });
        void queryClient.invalidateQueries({ queryKey: ["desktop"] });
        void queryClient.invalidateQueries({ queryKey: ["methods"] });
        void queryClient.invalidateQueries({ queryKey: ["proactive"] });
        void queryClient.invalidateQueries({ queryKey: ["memory"] });
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        void queryClient.invalidateQueries({ queryKey: ["reconcile"] });
        void queryClient.invalidateQueries({ queryKey: ["outbox"] });
        void queryClient.invalidateQueries({ queryKey: ["sources"] });
        if (event.startsWith("effect.")) {
          void queryClient.invalidateQueries({ queryKey: ["task"] });
        }
        if (["task.created", "task.updated", "task.follow-up.created", "task.follow-up.updated", "chat.message.created", "chat.message.updated", "message"].includes(event)) {
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        }
        if (event === "schedule.created" || event === "schedule.updated" || event === "schedule.run.created" || event === "schedule.run.updated") {
          void queryClient.invalidateQueries({ queryKey: ["schedules"] });
          void queryClient.invalidateQueries({ queryKey: ["scheduleRuns"] });
          void queryClient.invalidateQueries({ queryKey: ["conversations"] });
          void queryClient.invalidateQueries({ queryKey: ["conversation"] });
        }
        if (taskId) {
          void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
          void queryClient.invalidateQueries({ queryKey: ["task-context", taskId] });
          void queryClient.invalidateQueries({ queryKey: ["taskEvents", taskId] });
          void queryClient.invalidateQueries({ queryKey: ["task-follow-ups", taskId] });
          void queryClient.invalidateQueries({ queryKey: ["task-git", taskId] });
          void queryClient.invalidateQueries({ queryKey: ["task-git-diff", taskId] });
          void queryClient.invalidateQueries({ queryKey: ["task-git-file", taskId] });
        }
      }, 250);
    });
    return () => {
      window.clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [queryClient, taskId]);

  return null;
}
