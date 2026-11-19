import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App.tsx";
import "./styles.css";
import "./wizard.css";
import "./notifications.css";
import "./mail.css";
import "./styles/foundation.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
      refetchOnWindowFocus: true
    }
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);

if ("serviceWorker" in navigator) {
  if (window.hearthDesktop?.isDesktop || "__TAURI_INTERNALS__" in window) {
    // A previous browser session may have registered /sw.js on the same origin.
    // Desktop mode must run without a stale service worker so the packaged
    // server is always the source of truth.
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch((error) => {
        console.warn("Hearth desktop service worker cleanup failed", error);
      });
  } else if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("/sw.js").catch((error) => {
        console.warn("Hearth service worker registration failed", error);
      });
    });
  }
}
