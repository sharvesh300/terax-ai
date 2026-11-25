import { applyExecution, type EditResult, type ExecutionEvent } from "./ops";
import type { NotebookDocument } from "./types";

type Entry = {
  readonly doc: NotebookDocument;
  /** Cell to focus when this state is restored. */
  readonly focus: string | null;
  /** Consecutive commits with the same group (typing in one cell) merge. */
  readonly group: string | null;
};

export type NotebookHistory = {
  readonly past: readonly Entry[];
  readonly present: Entry;
  readonly future: readonly Entry[];
  /** The document as last read from or written to disk. */
  readonly saved: NotebookDocument;
};

const LIMIT = 200;

export function createHistory(doc: NotebookDocument): NotebookHistory {
  return {
    past: [],
    present: { doc, focus: null, group: null },
    future: [],
    saved: doc,
  };
}

export function commitEdit(
  h: NotebookHistory,
  result: EditResult,
  group: string | null = null,
): NotebookHistory {
  if (result.doc === h.present.doc) return h;
  const entry: Entry = { doc: result.doc, focus: result.focus, group };
  if (group !== null && group === h.present.group) {
    return { ...h, present: entry, future: [] };
  }
  const past = [...h.past, h.present];
  return {
    ...h,
    past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past,
    present: entry,
    future: [],
  };
}

export function undo(h: NotebookHistory): NotebookHistory {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return {
    ...h,
    past: h.past.slice(0, -1),
    // Focus the cell the undone edit touched; never merge into a restored state.
    present: { ...prev, focus: h.present.focus ?? prev.focus, group: null },
    future: [{ ...h.present, group: null }, ...h.future],
  };
}

export function redo(h: NotebookHistory): NotebookHistory {
  const [next, ...future] = h.future;
  if (!next) return h;
  return {
    ...h,
    past: [...h.past, { ...h.present, group: null }],
    present: next,
    future,
  };
}

export const canUndo = (h: NotebookHistory) => h.past.length > 0;
export const canRedo = (h: NotebookHistory) => h.future.length > 0;
export const isDirty = (h: NotebookHistory) => h.present.doc !== h.saved;

/** Records that `doc` (by default the current state) is what is on disk. */
export function markSaved(
  h: NotebookHistory,
  doc: NotebookDocument = h.present.doc,
): NotebookHistory {
  return { ...h, saved: doc, present: { ...h.present, group: null } };
}

/**
 * Applies kernel output to every state, so undoing an edit never rolls back
 * output that arrived after it.
 */
export function applyExecutionToHistory(
  h: NotebookHistory,
  ev: ExecutionEvent,
): NotebookHistory {
  const map = (e: Entry): Entry => {
    const doc = applyExecution(e.doc, ev);
    return doc === e.doc ? e : { ...e, doc };
  };
  const present = map(h.present);
  if (present === h.present) return h;
  return { ...h, past: h.past.map(map), present, future: h.future.map(map) };
}
