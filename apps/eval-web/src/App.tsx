import { Navigate, Route, Routes } from "react-router-dom";

export function App() {
  return (
    <Routes>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
