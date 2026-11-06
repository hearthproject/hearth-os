import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { subscribeToEvents } from "./lib/api.ts";
import { ArtifactsPage } from "./pages/ArtifactsPage.tsx";
import { AttentionPage } from "./pages/AttentionPage.tsx";
import { DevicesPage } from "./pages/DevicesPage.tsx";
import { InboxPage } from "./pages/InboxPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SourcesPage } from "./pages/SourcesPage.tsx";
import { OutboxPage } from "./pages/OutboxPage.tsx";
import { TaskDetailPage } from "./pages/TaskDetailPage.tsx";
import { TodayPage } from "./pages/TodayPage.tsx";

export default function App() {
  return (
    <>
      <EventBridge />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<TodayPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="attention" element={<AttentionPage />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="outbox" element={<OutboxPage />} />
          <Route path="sources" element={<SourcesPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="tasks/:id" element={<TaskDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}

function EventBridge() {
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const taskId = pathname.startsWith("/tasks/") ? decodeURIComponent(pathname.slice("/tasks/".length)) : null;

  useEffect(() => {
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeToEvents(() => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
        void queryClient.invalidateQueries({ queryKey: ["stats"] });
        void queryClient.invalidateQueries({ queryKey: ["system"] });
        void queryClient.invalidateQueries({ queryKey: ["sources"] });
        void queryClient.invalidateQueries({ queryKey: ["sourceItems"] });
        void queryClient.invalidateQueries({ queryKey: ["outbox"] });
        void queryClient.invalidateQueries({ queryKey: ["approvals"] });
        void queryClient.invalidateQueries({ queryKey: ["proactive"] });
        void queryClient.invalidateQueries({ queryKey: ["desktop"] });
        if (taskId) {
          void queryClient.invalidateQueries({ queryKey: ["task", taskId] });
          void queryClient.invalidateQueries({ queryKey: ["taskEvents", taskId] });
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
