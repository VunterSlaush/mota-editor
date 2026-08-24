import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The version the app shows. Baked in at build time rather than asked
// for over IPC: it is a constant of the build, it is wanted on the first
// frame, and the browser preview has no backend to ask. `npm test`
// checks that package.json, Cargo.toml and tauri.conf.json still agree,
// so this cannot quietly become a version nobody shipped.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

// Tauri expects a fixed dev port and no auto-open.
// Dev server on 1520; HMR websocket on 1521.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
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
