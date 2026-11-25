import { useFileWatch } from "@/modules/markdown/useFileWatch";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
} from "react";
import { toast } from "sonner";
import {
  initialSession,
  type ReadResult,
  type SessionEvent,
  type SessionState,
  sessionDirty,
  sessionReducer,
} from "./lib/session";
import { serializeNotebook } from "./model";

type FileStat = { size: number; mtime: number; kind: string };

const reduce = (state: SessionState, ev: SessionEvent) =>
  sessionReducer(state, ev);

/**
 * An open notebook: read from disk, edited in memory, saved back. Saves are
 * checked against the file's mtime (a change by another program shows a
 * warning with an explicit Overwrite, never a silent last-writer-wins), and
 * a change on disk reloads the view only when there is nothing unsaved.
 */
export function useNotebookSession(
  path: string,
  visible: boolean,
  force: boolean,
) {
  const [state, dispatch] = useReducer(reduce, initialSession);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  const requestRef = useRef(0);
  const read = useCallback(
    (discard = false) => {
      const id = ++requestRef.current;
      invoke<ReadResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
        force,
      })
        .then((result) => {
          if (id === requestRef.current)
            dispatch({ type: "read", result, discard });
        })
        .catch((e) => {
          if (id === requestRef.current)
            dispatch({ type: "readFailed", message: String(e) });
        });
    },
    [path, force],
  );

  useEffect(() => {
    read();
    return () => {
      // Results for an old path or force setting are ignored.
      requestRef.current++;
    };
  }, [read]);

  useFileWatch(path, visible, () => read());

  const write = useCallback(async (): Promise<boolean> => {
    const s = stateRef.current;
    if (s.kind !== "ready") return false;
    const doc = s.history.present.doc;
    const text = serializeNotebook(doc);
    // A read already in flight holds the file from before this write; its
    // result would look like an outside change and revert the view.
    requestRef.current++;
    try {
      const mtime = await invoke<number>("fs_write_file", {
        path,
        content: text,
        workspace: currentWorkspaceEnv(),
        source: "notebook",
      });
      dispatch({ type: "saved", doc, disk: { text, mtime } });
      return true;
    } catch (e) {
      toast.error("Could not save notebook", { description: String(e) });
      return false;
    }
  }, [path]);

  /** False when nothing was written (a conflict or a failed write). */
  const save = useCallback(async (): Promise<boolean> => {
    const s = stateRef.current;
    if (s.kind !== "ready" || !sessionDirty(s)) return true;
    const stat = await invoke<FileStat>("fs_stat", {
      path,
      workspace: currentWorkspaceEnv(),
    }).catch(() => null);
    if (stat && stat.mtime !== s.disk.mtime) {
      const name = path.split(/[\\/]/).pop() ?? path;
      toast.warning("File changed on disk", {
        id: `save-conflict:${path}`,
        description: `${name} was modified by another program while you had unsaved changes. Overwrite to keep your version.`,
        action: { label: "Overwrite", onClick: () => void write() },
      });
      return false;
    }
    return write();
  }, [path, write]);

  const send = useCallback((ev: SessionEvent) => dispatch(ev), []);
  const reloadFromDisk = useCallback(() => read(true), [read]);

  return { state, dispatch: send, save, reloadFromDisk };
}
