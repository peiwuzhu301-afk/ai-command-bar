import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed dev server port and an explicit host for in-app devtools.
// See https://v1.tauri.app/reference/configuration/#devserver for details.
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri:
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    watch: {
      // Don't watch the rust project; it's handled by tauri.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    target: ["es2021", "chrome100", "safari14"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
}));
