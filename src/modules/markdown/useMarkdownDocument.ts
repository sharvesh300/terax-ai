import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useFileWatch } from "./useFileWatch";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type MarkdownStatus =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

function toStatus(res: ReadResult): MarkdownStatus {
  if (res.kind === "text") return { kind: "ready", content: res.content };
  if (res.kind === "binary") return { kind: "binary" };
  return { kind: "toolarge", size: res.size, limit: res.limit };
}

/**
 * Reads `path` and keeps it current: an `fs:changed` for the file or an app
 * write to it re-reads after a short coalescing window. A reload never shows
 * the loading state, keeps the last good text when a read fails midway
 * through an agent's atomic rewrite, and returns the same status object when
 * nothing changed so unchanged documents do not re-render. A hidden tab only
 * remembers that it is stale and catches up when shown. `force` lifts the
 * 10 MB soft limit ("Open anyway"); the backend's 50 MB hard cap still holds.
 */
export function useMarkdownDocument(
  path: string,
  visible: boolean,
  force = false,
): MarkdownStatus {
  const [status, setStatus] = useState<MarkdownStatus>({ kind: "loading" });
  const readRef = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let requestId = 0;
    const workspace = currentWorkspaceEnv();
    setStatus({ kind: "loading" });

    const read = () => {
      const id = ++requestId;
      invoke<ReadResult>("fs_read_file", {
        path,
        workspace,
        force,
      })
        .then((res) => {
          if (!alive || id !== requestId) return;
          const next = toStatus(res);
          setStatus((prev) =>
            prev.kind === "ready" &&
            next.kind === "ready" &&
            prev.content === next.content
              ? prev
              : next,
          );
        })
        .catch((e) => {
          if (!alive || id !== requestId) return;
          setStatus((prev) =>
            prev.kind === "loading"
              ? { kind: "error", message: String(e) }
              : prev,
          );
        });
    };
    readRef.current = read;
    read();

    return () => {
      alive = false;
      readRef.current = () => {};
    };
  }, [path, force]);

  useFileWatch(path, visible, () => readRef.current());

  return status;
}
