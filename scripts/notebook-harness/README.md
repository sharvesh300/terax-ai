# Notebook harness

Renders the real notebook pane in a plain browser, against an in-memory
file system with the Tauri backend mocked, so editing, the keyboard modes,
dragging and saving can be tried without building the app.

```sh
node_modules/.bin/vite --config scripts/notebook-harness/vite.config.ts
```

Then open http://localhost:5198. `window.__notebookHarness` exposes the
files, the IPC log, the dirty flag, and `writeExternally(text)` to simulate
another program changing the notebook on disk.
