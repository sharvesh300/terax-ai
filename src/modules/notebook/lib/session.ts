// The state of an open notebook: what was read from disk, the edit history
// on top of it, and how the two relate. Pure; the hook around it does IO.

import {
  applyEdit,
  commitEdit,
  createHistory,
  type EditContext,
  isDirty,
  markSaved,
  type NotebookDocument,
  type NotebookEdit,
  type NotebookHistory,
  type NotebookParseError,
  parseNotebook,
  redo,
  undo,
} from "../model";

/** What `fs_read_file` returns. */
export type ReadResult =
  | { kind: "text"; content: string; size: number; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

type Disk = { readonly text: string; readonly mtime: number };

export type SessionState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "binary" }
  | { readonly kind: "toolarge"; readonly size: number; readonly limit: number }
  | {
      readonly kind: "invalid";
      readonly error: NotebookParseError;
      readonly disk: Disk;
    }
  | {
      readonly kind: "ready";
      readonly history: NotebookHistory;
      /** The file as last read or written. */
      readonly disk: Disk;
      /**
       * The file as changed on disk while there were unsaved edits. The edits
       * stay; the user picks between them and the file.
       */
      readonly changedOnDisk: Disk | null;
    };

export type SessionEvent =
  /** `discard` adopts the file even over unsaved edits ("Reload"). */
  | {
      readonly type: "read";
      readonly result: ReadResult;
      readonly discard?: boolean;
    }
  | { readonly type: "readFailed"; readonly message: string }
  | {
      readonly type: "edit";
      /** Applied to the latest document, so rapid edits never race. */
      readonly edit: NotebookEdit;
      /** Edits with the same group in a row are one undo step. */
      readonly group?: string | null;
    }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  /** `doc` is exactly what was written; later edits stay unsaved. */
  | {
      readonly type: "saved";
      readonly doc: NotebookDocument;
      readonly disk: Disk;
    }
  /** The user chose to keep their edits over the changed file. */
  | { readonly type: "keepMine" };

export const initialSession: SessionState = { kind: "loading" };

export function sessionDirty(s: SessionState): boolean {
  return s.kind === "ready" && isDirty(s.history);
}

function adopt(content: string, mtime: number): SessionState {
  const disk = { text: content, mtime };
  const parsed = parseNotebook(content);
  if (!parsed.ok) return { kind: "invalid", error: parsed.error, disk };
  return {
    kind: "ready",
    history: createHistory(parsed.doc),
    disk,
    changedOnDisk: null,
  };
}

export function sessionReducer(
  state: SessionState,
  ev: SessionEvent,
  ctx?: EditContext,
): SessionState {
  switch (ev.type) {
    case "read": {
      const { result } = ev;
      const dirty = sessionDirty(state);
      if (result.kind !== "text") {
        // Never drop unsaved edits for a file that became unreadable.
        if (dirty && !ev.discard) return state;
        return result.kind === "binary"
          ? { kind: "binary" }
          : { kind: "toolarge", size: result.size, limit: result.limit };
      }
      if (state.kind === "ready" || state.kind === "invalid") {
        // Our own save, or a touch that changed nothing.
        if (result.content === state.disk.text && !ev.discard) {
          return state.disk.mtime === result.mtime
            ? state
            : { ...state, disk: { ...state.disk, mtime: result.mtime } };
        }
        if (dirty && !ev.discard && state.kind === "ready") {
          const theirs = { text: result.content, mtime: result.mtime };
          return state.changedOnDisk?.text === theirs.text &&
            state.changedOnDisk.mtime === theirs.mtime
            ? state
            : { ...state, changedOnDisk: theirs };
        }
      }
      return adopt(result.content, result.mtime);
    }

    case "readFailed":
      // A failed reload (atomic rename in flight) keeps what is shown.
      return state.kind === "loading"
        ? { kind: "error", message: ev.message }
        : state;

    case "edit": {
      if (state.kind !== "ready") return state;
      const result = applyEdit(state.history.present.doc, ev.edit, ctx);
      return withHistory(state, commitEdit(state.history, result, ev.group));
    }

    case "undo":
      return state.kind === "ready"
        ? withHistory(state, undo(state.history))
        : state;

    case "redo":
      return state.kind === "ready"
        ? withHistory(state, redo(state.history))
        : state;

    case "saved":
      if (state.kind !== "ready") return state;
      return {
        ...state,
        history: markSaved(state.history, ev.doc),
        disk: ev.disk,
        changedOnDisk: null,
      };

    // Their version becomes the known baseline, so the next save writes
    // over it without another conflict warning.
    case "keepMine":
      return state.kind === "ready" && state.changedOnDisk
        ? { ...state, disk: state.changedOnDisk, changedOnDisk: null }
        : state;
  }
}

function withHistory(
  state: Extract<SessionState, { kind: "ready" }>,
  history: NotebookHistory,
): SessionState {
  return history === state.history ? state : { ...state, history };
}
