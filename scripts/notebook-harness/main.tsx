// Renders the real NotebookPane against an in-memory file system, so editing,
// keyboard modes, drag and saving can be tried in any browser. Inspect state
// from the console through `window.__notebookHarness`.
import "./harness.css";
import fixture from "@/modules/notebook/model/__fixtures__/jupyter-4.5.ipynb?raw";
import { NotebookPane } from "@/modules/notebook/NotebookPane";
import { ThemeProvider } from "@/modules/theme";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { fakeKernelCommand } from "./fakeKernel";

const PATH = "/demo/eda.ipynb";
const files = new Map<string, { text: string; mtime: number }>([
  [PATH, { text: fixture, mtime: 1 }],
]);
let clock = 1;
const log: { cmd: string; args: unknown }[] = [];

mockWindows("main");
mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    log.push({ cmd, args });
    if (cmd.startsWith("kernel_")) return fakeKernelCommand(cmd, a);
    switch (cmd) {
      case "fs_read_file": {
        const f = files.get(a.path as string);
        if (!f) return Promise.reject("not found");
        return { kind: "text", content: f.text, size: f.text.length, mtime: f.mtime };
      }
      case "fs_stat": {
        const f = files.get(a.path as string);
        return f ? { size: f.text.length, mtime: f.mtime, kind: "file" } : null;
      }
      case "fs_write_file": {
        const mtime = ++clock;
        files.set(a.path as string, { text: a.content as string, mtime });
        return mtime;
      }
      case "fs_canonicalize":
        return a.path;
      case "asset_grant":
        return "token";
      // @tauri-apps/plugin-store (preferences, custom themes): empty store.
      case "plugin:store|load":
        return 1;
      case "plugin:store|get":
        return [null, false];
      case "plugin:store|entries":
      case "plugin:store|keys":
      case "plugin:store|values":
        return [];
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

const state = { dirty: false, view: "rendered" as string };
Object.assign(window, {
  __notebookHarness: {
    path: PATH,
    files,
    log,
    state,
    /** Simulates another program writing the file. */
    writeExternally: (text: string) => files.set(PATH, { text, mtime: ++clock }),
  },
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <ThemeProvider>
      <div className="h-screen">
        <NotebookPane
          path={PATH}
          visible
          onSetView={(mode) => {
            state.view = mode;
          }}
          onDirtyChange={(dirty) => {
            state.dirty = dirty;
          }}
        />
      </div>
      <Toaster />
    </ThemeProvider>,
  );
}
