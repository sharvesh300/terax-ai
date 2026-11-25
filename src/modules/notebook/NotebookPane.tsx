import { useAssetGrant } from "@/lib/useAssetGrant";
import { cn } from "@/lib/utils";
import { checkReadable } from "@/modules/ai/lib/security";
import { MarkdownViewToggle } from "@/modules/markdown";
import { previewBoundary } from "@/modules/markdown/lib/assetPath";
import { useMarkdownDocument } from "@/modules/markdown/useMarkdownDocument";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type LocalImages,
  LocalImagesContext,
} from "./components/MarkdownCell";
import { NotebookCellView } from "./components/NotebookCellView";
import { mayHaveImages } from "./lib/attachments";
import { kernelLabel, notebookLanguage, renderKeys } from "./lib/display";
import { type NotebookDocument, parseNotebook } from "./model";

type Props = {
  path: string;
  /** Local images load only from beneath this folder (or the notebook's own). */
  workspaceRoot?: string | null;
  visible: boolean;
  onSetView: (mode: "rendered" | "raw") => void;
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
}: Props) {
  // "Open anyway" is a per-file decision; a renamed or new path starts unforced.
  const [forcedPath, setForcedPath] = useState<string | null>(null);
  const status = useMarkdownDocument(path, visible, forcedPath === path);
  const parsed = useMemo(
    () => (status.kind === "ready" ? parseNotebook(status.content) : null),
    [status],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger.
  useLayoutEffect(() => {
    scrollTopRef.current = 0;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [path]);

  const onScroll = useCallback(() => {
    scrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
  }, []);

  // A reload from disk replaces cells in place; keep the reader's position.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && parsed && el.scrollTop !== scrollTopRef.current) {
      el.scrollTop = scrollTopRef.current;
    }
  }, [parsed]);

  const openRaw = () => onSetView("raw");

  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <MarkdownViewToggle mode="rendered" onChange={onSetView} />
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-5xl px-6 py-5">
          {status.kind === "loading" && <Note>Loading…</Note>}
          {status.kind === "error" && (
            <Note tone="error">Failed to read file: {status.message}</Note>
          )}
          {status.kind === "binary" && (
            <Problem message="This file is not text, so it cannot be a notebook." />
          )}
          {status.kind === "toolarge" &&
            (status.size <= HARD_READ_LIMIT ? (
              <Problem
                message={`This notebook is ${formatBytes(status.size)}, over the ${formatBytes(status.limit)} limit for opening without asking.`}
                action={{
                  label: "Open anyway",
                  run: () => setForcedPath(path),
                }}
              />
            ) : (
              <Problem
                message={`This notebook is ${formatBytes(status.size)}, over the ${formatBytes(HARD_READ_LIMIT)} maximum.`}
              />
            ))}
          {parsed && !parsed.ok && (
            <Problem
              title="This notebook cannot be shown"
              message={parsed.error.message}
              onOpenRaw={openRaw}
            />
          )}
          {parsed?.ok && (
            <NotebookBody
              doc={parsed.doc}
              path={path}
              boundary={previewBoundary(path, workspaceRoot)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const isReadable = (abs: string) => checkReadable(abs).ok;

function NotebookBody({
  doc,
  path,
  boundary,
}: {
  doc: NotebookDocument;
  path: string;
  boundary: string;
}) {
  const keys = useMemo(() => renderKeys(doc.cells), [doc.cells]);
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
  return (
    <>
      {/* Right padding keeps the summary clear of the view toggle. */}
      <header className="mb-4 flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 pr-40 text-[11px] text-muted-foreground">
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
        <span className="rounded border border-border/60 px-1.5 py-px">
          Read-only
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
      {count === 0 ? (
        <Note>This notebook has no cells.</Note>
      ) : (
        <LocalImagesContext.Provider value={images}>
          <div className="flex flex-col gap-3">
            {doc.cells.map((cell, i) => (
              <NotebookCellView key={keys[i]} cell={cell} language={language} />
            ))}
          </div>
        </LocalImagesContext.Provider>
      )}
    </>
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
