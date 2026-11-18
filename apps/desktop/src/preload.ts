import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("hearthDesktop", {
  isDesktop: true,
  platform: process.platform
});
