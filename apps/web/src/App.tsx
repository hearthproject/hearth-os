import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { subscribeToEvents } from "./lib/api.ts";
import { ArtifactsPage } from "./pages/ArtifactsPage.tsx";
import { AttentionPage } from "./pages/AttentionPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TaskDetailPage } from "./pages/TaskDetailPage.tsx";
import { TodayPage } from "./pages/TodayPage.tsx";

export default function App() {
  return (
    <>
      <EventBridge />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<TodayPage />} />
          <Route path="attention" element={<AttentionPage />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
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

  useEffect(() => {
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeToEvents(() => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["task"] });
        void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
        void queryClient.invalidateQueries({ queryKey: ["health"] });
      }, 250);
    });
    return () => {
      window.clearTimeout(refreshTimer);
      unsubscribe();
    };
  }, [queryClient]);

  return null;
}
