import { cn } from "@/lib/utils";
import { workspaceRootOf } from "@/modules/markdown/lib/workspaceRoot";
import type { NotebookTab, Tab } from "@/modules/tabs";
import { useCallback, useEffect, useRef } from "react";
import { NotebookPane, type NotebookPaneHandle } from "./NotebookPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetDocumentView: (id: number, mode: "rendered" | "raw") => void;
  registerHandle: (id: number, handle: NotebookPaneHandle | null) => void;
  onDirtyChange: (id: number, dirty: boolean) => void;
};

export function NotebookStack({
  tabs,
  activeId,
  onSetDocumentView,
  registerHandle,
  onDirtyChange,
}: Props) {
  const notebooks = tabs.filter(
    (t): t is NotebookTab => t.kind === "notebook" && !t.cold,
  );

  // Stable per-tab callbacks, so panes are not re-rendered by new closures.
  const handleCallbacks = useRef(
    new Map<number, (h: NotebookPaneHandle | null) => void>(),
  );
  const dirtyCallbacks = useRef(new Map<number, (dirty: boolean) => void>());
  const registerRef = useRef(registerHandle);
  const dirtyRef = useRef(onDirtyChange);
  useEffect(() => {
    registerRef.current = registerHandle;
    dirtyRef.current = onDirtyChange;
  }, [registerHandle, onDirtyChange]);

  const handleFor = useCallback((id: number) => {
    let cb = handleCallbacks.current.get(id);
    if (!cb) {
      cb = (h) => registerRef.current(id, h);
      handleCallbacks.current.set(id, cb);
    }
    return cb;
  }, []);
  const dirtyFor = useCallback((id: number) => {
    let cb = dirtyCallbacks.current.get(id);
    if (!cb) {
      cb = (dirty) => dirtyRef.current(id, dirty);
      dirtyCallbacks.current.set(id, cb);
    }
    return cb;
  }, []);

  const liveIds = notebooks.map((t) => t.id).join(",");
  useEffect(() => {
    const live = new Set(liveIds.split(",").filter(Boolean).map(Number));
    for (const map of [handleCallbacks.current, dirtyCallbacks.current]) {
      for (const id of map.keys()) if (!live.has(id)) map.delete(id);
    }
  }, [liveIds]);

  if (notebooks.length === 0) return null;
  const workspaceRoot = workspaceRootOf(tabs, activeId);
  return (
    <div className="relative h-full w-full">
      {notebooks.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <NotebookPane
              path={t.path}
              workspaceRoot={workspaceRoot}
              visible={visible}
              onSetView={(mode) => onSetDocumentView(t.id, mode)}
              registerHandle={handleFor(t.id)}
              onDirtyChange={dirtyFor(t.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
