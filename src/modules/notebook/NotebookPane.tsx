import { useAssetGrant } from "@/lib/useAssetGrant";
import { cn } from "@/lib/utils";
import { checkReadable } from "@/modules/ai/lib/security";
import { MarkdownViewToggle } from "@/modules/markdown";
import { previewBoundary } from "@/modules/markdown/lib/assetPath";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type LocalImages,
  LocalImagesContext,
} from "./components/MarkdownCell";
import {
  NotebookEditor,
  type NotebookEditorHandle,
} from "./components/NotebookEditor";
import { useKernel } from "./kernel/useKernel";
import { mayHaveImages } from "./lib/attachments";
import { kernelLabel, notebookLanguage } from "./lib/display";
import { sessionDirty } from "./lib/session";
import type { NotebookDocument } from "./model";
import { useNotebookSession } from "./useNotebookSession";

/** What the app's Save / Undo / Redo shortcuts drive in a notebook tab. */
export type NotebookPaneHandle = {
  save: () => Promise<boolean>;
  undo: () => void;
  redo: () => void;
};

type Props = {
  path: string;
  /** Local images load only from beneath this folder (or the notebook's own). */
  workspaceRoot?: string | null;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
  registerHandle?: (handle: NotebookPaneHandle | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

/// Mirrors FORCE_MAX_READ_BYTES in src-tauri fs/file.rs.
const HARD_READ_LIMIT = 50 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function NotebookPane({
  path,
  workspaceRoot = null,
  visible,
  onSetView,
  registerHandle,
  onDirtyChange,
}: Props) {
  // "Open anyway" is a per-file decision; a renamed or new path starts unforced.
  const [forcedPath, setForcedPath] = useState<string | null>(null);
  const { state, dispatch, save, reloadFromDisk } = useNotebookSession(
    path,
    visible,
    forcedPath === path,
  );
  const dirty = sessionDirty(state);
  const editorRef = useRef<NotebookEditorHandle>(null);

  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const kernel = useKernel({
    path,
    workspaceRoot,
    dispatch,
    getDoc: useCallback(() => {
      const s = stateRef.current;
      return s.kind === "ready" ? s.history.present.doc : null;
    }, []),
  });

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const saveRef = useRef(save);
  useLayoutEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (!registerHandle) return;
    registerHandle({
      save: () => saveRef.current(),
      undo: () => {
        if (editorRef.current) editorRef.current.undo();
        else dispatch({ type: "undo" });
      },
      redo: () => {
        if (editorRef.current) editorRef.current.redo();
        else dispatch({ type: "redo" });
      },
    });
    return () => registerHandle(null);
  }, [registerHandle, dispatch]);

  const openRaw = () => onSetView("raw");

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <MarkdownViewToggle
        mode="rendered"
        onChange={onSetView}
        rawDisabled={dirty}
        rawHint="Save to view the raw file"
      />
      {state.kind === "ready" ? (
        <>
          {state.changedOnDisk && (
            <div
              role="alert"
              className="flex shrink-0 items-center gap-3 border-b border-border/60 bg-card px-4 py-2 pr-40 text-[12px]"
            >
              <span className="text-foreground">
                This notebook changed on disk while you had unsaved changes.
              </span>
              <button
                type="button"
                onClick={reloadFromDisk}
                className="rounded border border-border/60 px-2 py-0.5 hover:bg-accent"
              >
                Reload from disk
              </button>
              <button
                type="button"
                onClick={() => dispatch({ type: "keepMine" })}
                className="rounded border border-border/60 px-2 py-0.5 hover:bg-accent"
              >
                Keep my version
              </button>
            </div>
          )}
          <ReadyNotebook
            doc={state.history.present.doc}
            path={path}
            boundary={previewBoundary(path, workspaceRoot)}
          >
            {(summary, language) => (
              <NotebookEditor
                ref={editorRef}
                history={state.history}
                dispatch={dispatch}
                language={language}
                dirty={dirty}
                onSave={() => void save()}
                summary={summary}
                kernel={kernel}
              />
            )}
          </ReadyNotebook>
        </>
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-5xl px-6 py-5">
            {state.kind === "loading" && <Note>Loading…</Note>}
            {state.kind === "error" && (
              <Note tone="error">Failed to read file: {state.message}</Note>
            )}
            {state.kind === "binary" && (
              <Problem message="This file is not text, so it cannot be a notebook." />
            )}
            {state.kind === "toolarge" &&
              (state.size <= HARD_READ_LIMIT ? (
                <Problem
                  message={`This notebook is ${formatBytes(state.size)}, over the ${formatBytes(state.limit)} limit for opening without asking.`}
                  action={{
                    label: "Open anyway",
                    run: () => setForcedPath(path),
                  }}
                />
              ) : (
                <Problem
                  message={`This notebook is ${formatBytes(state.size)}, over the ${formatBytes(HARD_READ_LIMIT)} maximum.`}
                />
              ))}
            {state.kind === "invalid" && (
              <Problem
                title="This notebook cannot be shown"
                message={state.error.message}
                onOpenRaw={openRaw}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const isReadable = (abs: string) => checkReadable(abs).ok;

/** Notebook-wide context for the editor: summary line and local images. */
function ReadyNotebook({
  doc,
  path,
  boundary,
  children,
}: {
  doc: NotebookDocument;
  path: string;
  boundary: string;
  children: (summary: ReactNode, language: string | null) => ReactNode;
}) {
  const kernel = kernelLabel(doc.metadata);
  const language = notebookLanguage(doc.metadata);
  // The asset grant is a backend call; only notebooks that may show local
  // images ask for one.
  const wantsImages = useMemo(
    () =>
      doc.cells.some(
        (c) => c.cellType === "markdown" && mayHaveImages(c.source),
      ),
    [doc.cells],
  );
  const {
    urlFor,
    error: imagesError,
    retry,
  } = useAssetGrant(wantsImages ? boundary : null);
  const images = useMemo<LocalImages | null>(
    () => (wantsImages ? { path, boundary, urlFor, isReadable } : null),
    [wantsImages, path, boundary, urlFor],
  );
  const count = doc.cells.length;
  const summary = (
    <>
      <header className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground/80">
          {kernel ?? "Unknown kernel"}
        </span>
        <span aria-hidden>·</span>
        <span>
          {count} {count === 1 ? "cell" : "cells"}
        </span>
        <span aria-hidden>·</span>
        <span>
          nbformat {doc.nbformat}.{doc.nbformatMinor}
        </span>
      </header>
      {wantsImages && imagesError && (
        <div className="mb-3 flex gap-2 text-[11px] text-muted-foreground">
          <p role="alert">Local images unavailable: {imagesError}</p>
          <button type="button" className="underline" onClick={retry}>
            Retry
          </button>
        </div>
      )}
    </>
  );
  return (
    <LocalImagesContext.Provider value={images}>
      <div className="min-h-0 flex-1">{children(summary, language)}</div>
    </LocalImagesContext.Provider>
  );
}

function Note({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <p
      className={cn(
        "text-[12px]",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

function Problem({
  title,
  message,
  onOpenRaw,
  action,
}: {
  title?: string;
  message: string;
  onOpenRaw?: () => void;
  action?: { label: string; run: () => void };
}) {
  return (
    <div className="mt-10 flex max-w-md flex-col gap-3 text-[12px]">
      {title && <p className="font-medium text-foreground">{title}</p>}
      <p className="text-muted-foreground">{message}</p>
      <div className="flex gap-2">
        {action && (
          <button
            type="button"
            onClick={action.run}
            className="rounded-md border border-border/60 bg-card px-2.5 py-1 hover:bg-accent"
          >
            {action.label}
          </button>
        )}
        {onOpenRaw && (
          <button
            type="button"
            onClick={onOpenRaw}
            className="rounded-md border border-border/60 bg-card px-2.5 py-1 hover:bg-accent"
          >
            Open as text
          </button>
        )}
      </div>
    </div>
  );
}
