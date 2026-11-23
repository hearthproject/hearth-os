export const pageLoaders = {
  library: () => import("../pages/LibraryPage.tsx"),
  context: () => import("../pages/ContextPage.tsx"),
  mail: () => import("../pages/MailPage.tsx"),
  schedules: () => import("../pages/SchedulesPage.tsx"),
  connections: () => import("../pages/ConnectionsPage.tsx"),
  settings: () => import("../pages/SettingsPage.tsx"),
  onboarding: () => import("../pages/OnboardingPage.tsx")
} as const;

const PATH_LOADERS: Record<string, () => Promise<unknown>> = {
  "/library": pageLoaders.library,
  "/context": pageLoaders.context,
  "/mail": pageLoaders.mail,
  "/schedules": pageLoaders.schedules,
  "/connections": pageLoaders.connections,
  "/settings": pageLoaders.settings,
  "/welcome": pageLoaders.onboarding
};

/** Warm a route chunk on hover/focus so navigation feels instant. */
export function prefetchRoute(path: string): void {
  const loader = PATH_LOADERS[path];
  if (loader) void loader().catch(() => undefined);
}
