import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useLayoutEffect, useRef } from "react";
import { createCoalescer, touchesPath } from "./lib/liveReload";

/**
 * Calls `onChange` after `path` changes on disk: an `fs:changed` for the file
 * or an app write to it, coalesced over a short window. A hidden view only
 * remembers that it is stale and is told once it is shown again.
 */
export function useFileWatch(
  path: string,
  visible: boolean,
  onChange: () => void,
): void {
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  });
  const visibleRef = useRef(visible);
  const staleRef = useRef(false);

  useEffect(() => {
    visibleRef.current = visible;
    if (visible && staleRef.current) {
      staleRef.current = false;
      onChangeRef.current();
    }
  }, [visible]);

  useEffect(() => {
    let alive = true;
    const workspace = currentWorkspaceEnv();
    // The watcher reports canonical paths; the tab may hold an alias spelling.
    let canonical: string | null = null;
    staleRef.current = false;

    const coalescer = createCoalescer(() => onChangeRef.current());
    const onTouched = () => {
      if (visibleRef.current) coalescer.poke();
      else staleRef.current = true;
    };
    const matches = (paths: readonly string[]) =>
      touchesPath(paths, path) ||
      (canonical !== null && touchesPath(paths, canonical));

    const dir = parentDir(path);
    watchAdd([dir], [path], workspace);
    const unlisten: Array<() => void> = [];
    const track = (pending: Promise<() => void>) =>
      void pending.then((un) => (alive ? unlisten.push(un) : un()));
    track(
      listenFsChanged((paths) => {
        if (matches(paths)) onTouched();
      }),
    );
    track(
      getCurrentWebviewWindow().listen<{ path: string }>(
        "fs:file-written",
        (e) => {
          if (matches([e.payload.path])) onTouched();
        },
      ),
    );
    invoke<string>("fs_canonicalize", { path, workspace })
      .then((c) => {
        if (alive) canonical = c;
      })
      .catch(() => {});

    return () => {
      alive = false;
      coalescer.cancel();
      for (const un of unlisten) un();
      watchRemove([dir], [path], workspace);
    };
  }, [path]);
}
