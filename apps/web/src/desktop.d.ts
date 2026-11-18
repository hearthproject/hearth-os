export {};

declare global {
  interface Window {
    hearthDesktop?: {
      isDesktop: true;
      platform: string;
    };
  }
}
