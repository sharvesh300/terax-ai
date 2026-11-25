// Where parsed values came from in the file, keyed by object identity.
//
// The model is immutable, so a value that still has its parsed identity is
// unchanged and can be written back as its original text. Edits create new
// objects, which have no entry and are written fresh. Keeping this out of the
// model types means a spread copy can never carry a stale origin.

import type { NotebookCell, NotebookDocument } from "./types";

type RawEntry = { readonly text: string; readonly layout: string };

const rawText = new WeakMap<object, RawEntry>();

/** A file's indent and line ending; raw text is only reused under the same one. */
export function layoutKey(indent: string | null, eol: string): string {
  return indent === null ? "compact" : `${indent}|${eol}`;
}

export function rememberRaw(value: object, text: string, layout: string) {
  rawText.set(value, { text, layout });
}

export function rawFor(value: object, layout: string): string | undefined {
  const e = rawText.get(value);
  return e && e.layout === layout ? e.text : undefined;
}

type CellOrigin = {
  /** The parsed source and its original text (string or line list). */
  readonly source: string;
  readonly sourceText: string;
  readonly keyOrder: readonly string[];
};

const cellOrigins = new WeakMap<NotebookCell, CellOrigin>();

export function rememberCellOrigin(cell: NotebookCell, origin: CellOrigin) {
  cellOrigins.set(cell, origin);
}

export function cellOrigin(cell: NotebookCell): CellOrigin | undefined {
  return cellOrigins.get(cell);
}

type DocOrigin = { readonly keyOrder: readonly string[] };

const docOrigins = new WeakMap<NotebookDocument, DocOrigin>();
/** The exact file text, valid only while the document is unedited. */
const docText = new WeakMap<NotebookDocument, string>();

export function rememberDocOrigin(
  doc: NotebookDocument,
  origin: DocOrigin,
  text: string,
) {
  docOrigins.set(doc, origin);
  docText.set(doc, text);
}

export function docOrigin(doc: NotebookDocument): DocOrigin | undefined {
  return docOrigins.get(doc);
}

export function unchangedDocText(doc: NotebookDocument): string | undefined {
  return docText.get(doc);
}

/** Derives an edited cell, keeping its member order and source text origin. */
export function deriveCell(
  cell: NotebookCell,
  patch: Partial<Omit<NotebookCell, "key">> & { key?: string },
): NotebookCell {
  const next: NotebookCell = { ...cell, ...patch };
  const origin = cellOrigins.get(cell);
  if (origin) cellOrigins.set(next, origin);
  return next;
}

/** Derives an edited document, keeping its member order. */
export function deriveDoc(
  doc: NotebookDocument,
  patch: Partial<NotebookDocument>,
): NotebookDocument {
  const next: NotebookDocument = { ...doc, ...patch };
  const origin = docOrigins.get(doc);
  if (origin) docOrigins.set(next, origin);
  return next;
}
