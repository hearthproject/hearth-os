import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { subscribeToEvents } from "./lib/api.ts";
import { ChatPage } from "./pages/ChatPage.tsx";
import { DevicesPage } from "./pages/DevicesPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { SchedulesPage } from "./pages/SchedulesPage.tsx";
import { TaskDetailPage } from "./pages/TaskDetailPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";

export default function App() {
  return (
    <>
      <EventBridge />
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<ChatPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:id" element={<TaskDetailPage />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="settings" element={<SettingsPage />} />
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
    const unsubscribe = subscribeToEvents((event) => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["health"] });
        void queryClient.invalidateQueries({ queryKey: ["system"] });
        void queryClient.invalidateQueries({ queryKey: ["desktop"] });
        if (["task.created", "task.updated", "chat.message.created", "message"].includes(event)) {
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
