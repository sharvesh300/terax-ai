import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev-only page that renders the notebook pane in a plain browser, with the
// Tauri backend mocked (see main.tsx). Not part of the app build.
const root = fileURLToPath(new URL(".", import.meta.url));
const repo = path.resolve(root, "../..");

export default defineConfig({
  root,
  cacheDir: path.join(os.tmpdir(), "terax-notebook-harness-vite"),
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.TERAX_NOTEBOOK_HARNESS_PORT ?? 5198),
    strictPort: true,
    fs: { allow: [repo] },
  },
  resolve: {
    alias: [{ find: "@", replacement: path.join(repo, "src") }],
  },
  define: { __TERAX_BENCH__: "false" },
});
