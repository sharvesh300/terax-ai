import type { JsonObject, JsonValue } from "./json";
import { deriveCell, deriveDoc } from "./origin";
import { DEFAULT_FORMAT, defaultCreateKey, type KeyFactory } from "./parse";
import type {
  CellType,
  MimeBundle,
  NotebookCell,
  NotebookDocument,
  NotebookOutput,
} from "./types";

export type EditContext = {
  readonly createKey: KeyFactory;
  /** A new nbformat 4.5 cell id not in `taken`. */
  readonly createId: (taken: ReadonlySet<string>) => string;
};

// nbformat's `random_cell_id`: uuid4().hex[:8].
function randomCellId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
    if (!taken.has(id)) return id;
  }
}

const defaultEditContext: EditContext = {
  createKey: defaultCreateKey,
  createId: randomCellId,
};

/** User edits; each one is a single undo step. */
export type NotebookEdit =
  | {
      readonly type: "insert";
      readonly index: number;
      readonly cellType: CellType;
      readonly source?: string;
    }
  | { readonly type: "delete"; readonly keys: readonly string[] }
  | { readonly type: "move"; readonly key: string; readonly toIndex: number }
  | { readonly type: "duplicate"; readonly key: string }
  | {
      readonly type: "setType";
      readonly key: string;
      readonly cellType: CellType;
    }
  | {
      readonly type: "setSource";
      readonly key: string;
      readonly source: string;
    }
  /** Splits at these source offsets (e.g. a cursor, or a selection's ends). */
  | {
      readonly type: "split";
      readonly key: string;
      readonly offsets: readonly number[];
    }
  | { readonly type: "merge"; readonly keys: readonly string[] }
  /** Clears outputs and execution counts; all code cells when `keys` is absent. */
  | { readonly type: "clearOutputs"; readonly keys?: readonly string[] };

export type EditResult = {
  readonly doc: NotebookDocument;
  /** The cell that should take focus afterwards, if the edit implies one. */
  readonly focus: string | null;
};

const unchanged = (doc: NotebookDocument): EditResult => ({ doc, focus: null });

function takenIds(doc: NotebookDocument): Set<string> {
  const ids = new Set<string>();
  for (const c of doc.cells) if (c.id !== null) ids.add(c.id);
  return ids;
}

function newCell(
  doc: NotebookDocument,
  cellType: CellType,
  source: string,
  ctx: EditContext,
  taken: ReadonlySet<string> = takenIds(doc),
): NotebookCell {
  return {
    key: ctx.createKey(),
    // Ids exist from nbformat 4.5; older files stay valid without them.
    id: doc.nbformatMinor >= 5 ? ctx.createId(taken) : null,
    cellType,
    source,
    metadata: {},
    attachments: null,
    outputs: [],
    executionCount: null,
    extra: {},
  };
}

const withCells = (doc: NotebookDocument, cells: readonly NotebookCell[]) =>
  deriveDoc(doc, { cells });

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.trunc(n), lo), hi);

/** Converts a cell's type; outputs and attachments follow nbformat's schema. */
function convertCell(cell: NotebookCell, cellType: CellType): NotebookCell {
  if (cell.cellType === cellType) return cell;
  return deriveCell(cell, {
    cellType,
    outputs: [],
    executionCount: null,
    // Code cells have no attachments in nbformat; markdown <-> raw keep them.
    attachments: cellType === "code" ? null : cell.attachments,
  });
}

export function applyEdit(
  doc: NotebookDocument,
  edit: NotebookEdit,
  ctx: EditContext = defaultEditContext,
): EditResult {
  const { cells } = doc;
  const indexOf = (key: string) => cells.findIndex((c) => c.key === key);

  switch (edit.type) {
    case "insert": {
      const index = clamp(edit.index, 0, cells.length);
      const cell = newCell(doc, edit.cellType, edit.source ?? "", ctx);
      const next = [...cells];
      next.splice(index, 0, cell);
      return { doc: withCells(doc, next), focus: cell.key };
    }

    case "delete": {
      const drop = new Set(edit.keys);
      const first = cells.findIndex((c) => drop.has(c.key));
      if (first === -1) return unchanged(doc);
      const next = cells.filter((c) => !drop.has(c.key));
      const focus = next[Math.min(first, next.length - 1)]?.key ?? null;
      return { doc: withCells(doc, next), focus };
    }

    case "move": {
      const from = indexOf(edit.key);
      if (from === -1) return unchanged(doc);
      const to = clamp(edit.toIndex, 0, cells.length - 1);
      if (to === from) return unchanged(doc);
      const next = [...cells];
      const [cell] = next.splice(from, 1);
      next.splice(to, 0, cell);
      return { doc: withCells(doc, next), focus: cell.key };
    }

    case "duplicate": {
      const i = indexOf(edit.key);
      if (i === -1) return unchanged(doc);
      const src = cells[i];
      const copy = deriveCell(src, {
        key: ctx.createKey(),
        id:
          src.id !== null || doc.nbformatMinor >= 5
            ? ctx.createId(takenIds(doc))
            : null,
      });
      const next = [...cells];
      next.splice(i + 1, 0, copy);
      return { doc: withCells(doc, next), focus: copy.key };
    }

    case "setType": {
      const i = indexOf(edit.key);
      if (i === -1 || cells[i].cellType === edit.cellType)
        return unchanged(doc);
      const next = [...cells];
      next[i] = convertCell(cells[i], edit.cellType);
      return { doc: withCells(doc, next), focus: edit.key };
    }

    case "setSource": {
      const i = indexOf(edit.key);
      if (i === -1 || cells[i].source === edit.source) return unchanged(doc);
      const next = [...cells];
      next[i] = deriveCell(cells[i], { source: edit.source });
      return { doc: withCells(doc, next), focus: null };
    }

    case "split": {
      const i = indexOf(edit.key);
      if (i === -1) return unchanged(doc);
      const cell = cells[i];
      const len = cell.source.length;
      const cuts = [...new Set(edit.offsets.map((o) => Math.trunc(o)))]
        .filter((o) => o > 0 && o < len)
        .sort((a, b) => a - b);
      if (cuts.length === 0) return unchanged(doc);
      const bounds = [0, ...cuts, len];
      // Like JupyterLab: blank lines at the cut are dropped.
      const parts = bounds.slice(1).map((end, j) =>
        cell.source
          .slice(bounds[j], end)
          .replace(/^(\r?\n)+/, "")
          .replace(/(\r?\n)+$/, ""),
      );
      const taken = takenIds(doc);
      const pieces = parts.map((source, j) => {
        const last = j === parts.length - 1;
        // The first piece keeps the cell's identity; the last one keeps its
        // outputs, since the end of a cell is what produced its result.
        const base =
          j === 0
            ? deriveCell(cell, { source })
            : newCell(doc, cell.cellType, source, ctx, taken);
        if (base.id !== null) taken.add(base.id);
        if (cell.cellType !== "code") return base;
        return deriveCell(base, {
          outputs: last ? cell.outputs : [],
          executionCount: last ? cell.executionCount : null,
        });
      });
      const next = [...cells];
      next.splice(i, 1, ...pieces);
      return { doc: withCells(doc, next), focus: pieces[1]?.key ?? null };
    }

    case "merge": {
      const wanted = new Set(edit.keys);
      const picked = cells.filter((c) => wanted.has(c.key));
      if (picked.length < 2) return unchanged(doc);
      const [target] = picked;
      const isCode = target.cellType === "code";
      const counted = picked.filter((c) => c.executionCount !== null);
      let attachments: JsonObject | null = target.attachments;
      if (!isCode) {
        const merged: Record<string, JsonValue> = {};
        for (const c of [...picked].reverse())
          Object.assign(merged, c.attachments);
        attachments = Object.keys(merged).length > 0 ? merged : null;
      }
      const merged = deriveCell(target, {
        source: picked.map((c) => c.source).join("\n\n"),
        attachments,
        outputs: isCode ? picked.flatMap((c) => c.outputs) : [],
        executionCount:
          isCode && counted.length === 1 && counted[0] === target
            ? target.executionCount
            : null,
      });
      const next = cells
        .filter((c) => c === target || !wanted.has(c.key))
        .map((c) => (c === target ? merged : c));
      return { doc: withCells(doc, next), focus: merged.key };
    }

    case "clearOutputs": {
      const only = edit.keys ? new Set(edit.keys) : null;
      let changed = false;
      const next = cells.map((c) => {
        if (c.cellType !== "code" || (only && !only.has(c.key))) return c;
        if (c.outputs.length === 0 && c.executionCount === null) return c;
        changed = true;
        return deriveCell(c, { outputs: [], executionCount: null });
      });
      return changed
        ? { doc: withCells(doc, next), focus: null }
        : unchanged(doc);
    }
  }
}

/** Kernel results; not undo steps (like Jupyter, undo covers edits only). */
export type ExecutionEvent =
  | {
      readonly type: "setOutputs";
      readonly key: string;
      readonly outputs: readonly NotebookOutput[];
    }
  | {
      readonly type: "appendOutput";
      readonly key: string;
      readonly output: NotebookOutput;
    }
  | {
      readonly type: "updateDisplay";
      readonly displayId: string;
      readonly data: MimeBundle;
      readonly metadata: JsonObject;
    }
  | {
      readonly type: "setExecutionCount";
      readonly key: string;
      readonly count: number | null;
    }
  /** Top-level metadata the kernel describes (kernelspec, language_info). */
  | { readonly type: "setNotebookMetadata"; readonly patch: JsonObject };

/**
 * Drops text a carriage return overwrote, as JupyterLab does when output
 * arrives, so a progress bar keeps one line instead of every frame.
 */
export function compactStreamText(text: string): string {
  if (!text.includes("\r")) return text;
  return text.replace(/\r+\n/g, "\n").replace(/^[^\n]*\r(?=[^\r\n])/gm, "");
}

function updateCell(
  doc: NotebookDocument,
  key: string,
  fn: (c: NotebookCell) => NotebookCell,
): NotebookDocument {
  const i = doc.cells.findIndex((c) => c.key === key);
  if (i === -1 || doc.cells[i].cellType !== "code") return doc;
  const cell = fn(doc.cells[i]);
  if (cell === doc.cells[i]) return doc;
  const next = [...doc.cells];
  next[i] = cell;
  return withCells(doc, next);
}

export function applyExecution(
  doc: NotebookDocument,
  ev: ExecutionEvent,
): NotebookDocument {
  switch (ev.type) {
    case "setOutputs":
      return updateCell(doc, ev.key, (c) =>
        deriveCell(c, { outputs: ev.outputs }),
      );

    case "appendOutput":
      return updateCell(doc, ev.key, (c) => {
        const last = c.outputs[c.outputs.length - 1];
        const o = ev.output;
        // Consecutive chunks of one stream are one output, as Jupyter saves them.
        if (
          last?.outputType === "stream" &&
          o.outputType === "stream" &&
          last.name === o.name
        ) {
          const joined = {
            ...last,
            text: compactStreamText(last.text + o.text),
          };
          return deriveCell(c, {
            outputs: [...c.outputs.slice(0, -1), joined],
          });
        }
        const added =
          o.outputType === "stream"
            ? { ...o, text: compactStreamText(o.text) }
            : o;
        return deriveCell(c, { outputs: [...c.outputs, added] });
      });

    case "updateDisplay": {
      let changed = false;
      const cells = doc.cells.map((c) => {
        if (c.cellType !== "code") return c;
        let hit = false;
        const outputs = c.outputs.map((o) => {
          if (
            (o.outputType === "display_data" ||
              o.outputType === "execute_result") &&
            o.displayId === ev.displayId
          ) {
            hit = true;
            return { ...o, data: ev.data, metadata: ev.metadata };
          }
          return o;
        });
        if (!hit) return c;
        changed = true;
        return deriveCell(c, { outputs });
      });
      return changed ? withCells(doc, cells) : doc;
    }

    case "setExecutionCount":
      return updateCell(doc, ev.key, (c) =>
        c.executionCount === ev.count
          ? c
          : deriveCell(c, { executionCount: ev.count }),
      );

    case "setNotebookMetadata": {
      const keys = Object.keys(ev.patch);
      const same = keys.every(
        (k) => JSON.stringify(doc.metadata[k]) === JSON.stringify(ev.patch[k]),
      );
      return same
        ? doc
        : deriveDoc(doc, { metadata: { ...doc.metadata, ...ev.patch } });
    }
  }
}

/** An empty notebook as Jupyter creates one: nbformat 4.5, one code cell. */
export function createNotebook(
  ctx: EditContext = defaultEditContext,
  format?: NotebookDocument["format"],
): NotebookDocument {
  const empty: NotebookDocument = {
    nbformat: 4,
    nbformatMinor: 5,
    metadata: {},
    cells: [],
    extra: {},
    format: format ?? DEFAULT_FORMAT,
    hadNonStandardNumbers: false,
  };
  return { ...empty, cells: [newCell(empty, "code", "", ctx)] };
}
