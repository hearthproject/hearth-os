export {};

declare global {
  interface Window {
    hearthDesktop?: {
      isDesktop: true;
      platform: string;
    };
    __TAURI_INTERNALS__?: unknown;
  }
}
