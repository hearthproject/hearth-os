import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react() as unknown as PluginOption],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4318"
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
