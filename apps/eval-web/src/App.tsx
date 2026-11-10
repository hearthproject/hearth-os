import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { ActivityPage } from "./pages/ActivityPage.tsx";
import { CaseDetailPage } from "./pages/CaseDetailPage.tsx";
import { CasesPage } from "./pages/CasesPage.tsx";
import { ComparePage } from "./pages/ComparePage.tsx";
import { DashboardPage } from "./pages/DashboardPage.tsx";
import { ExperimentDetailPage } from "./pages/ExperimentDetailPage.tsx";
import { ExperimentsPage } from "./pages/ExperimentsPage.tsx";
import { NewExperimentPage } from "./pages/NewExperimentPage.tsx";
import { ReviewsPage } from "./pages/ReviewsPage.tsx";
import { RunDetailPage } from "./pages/RunDetailPage.tsx";
import { SystemPage } from "./pages/SystemPage.tsx";

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="cases" element={<CasesPage />} />
        <Route path="cases/:caseKey" element={<CaseDetailPage />} />
        <Route path="experiments" element={<ExperimentsPage />} />
        <Route path="experiments/new" element={<NewExperimentPage />} />
        <Route path="experiments/:id" element={<ExperimentDetailPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="reviews" element={<ReviewsPage />} />
        <Route path="compare" element={<ComparePage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="system" element={<SystemPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
