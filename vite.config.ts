import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and no auto-open.
// Dev server on 1520; HMR websocket on 1521.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1520,
    strictPort: true,
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1521,
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
});
