import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  parseLenient,
  type ScanResult,
  type SpanNode,
  scanJson,
} from "./json";
import { isJsonMime, joinMultiline } from "./lines";
import {
  layoutKey,
  rememberCellOrigin,
  rememberDocOrigin,
  rememberRaw,
} from "./origin";
import type {
  CellType,
  MimeBundle,
  NotebookCell,
  NotebookDocument,
  NotebookFormat,
  NotebookOutput,
  NotebookParseResult,
} from "./types";

export type KeyFactory = () => string;

let keyCounter = 0;
/** Default in-memory cell key source; unique for the app session. */
export const defaultCreateKey: KeyFactory = () => `cell-${++keyCounter}`;

/** Jupyter's default format for new notebooks. */
export const DEFAULT_FORMAT: NotebookFormat = {
  indent: " ",
  compactSpaces: true,
  sortKeys: true,
  eol: "\n",
  trailingNewline: "\n",
  bom: false,
};

// Root (0) → cells array (1) → cell (2) → outputs array (3) → output (4).
const SCAN_DEPTH = 4;

const CELL_TYPES: ReadonlySet<string> = new Set(["code", "markdown", "raw"]);
const CELL_KEYS = new Set([
  "id",
  "cell_type",
  "source",
  "metadata",
  "attachments",
  "outputs",
  "execution_count",
]);
const DOC_KEYS = new Set(["cells", "metadata", "nbformat", "nbformat_minor"]);

const notNotebook = (message: string): NotebookParseResult => ({
  ok: false,
  error: { kind: "not-notebook", message },
});

export function parseNotebook(
  fileText: string,
  createKey: KeyFactory = defaultCreateKey,
): NotebookParseResult {
  const bom = fileText.charCodeAt(0) === 0xfeff;
  const text = bom ? fileText.slice(1) : fileText;

  let scan: ScanResult;
  let value: JsonValue;
  try {
    scan = scanJson(text, SCAN_DEPTH);
    value = parseLenient(text, scan.nonStandard);
  } catch (e) {
    return {
      ok: false,
      error: {
        kind: "invalid-json",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (!isJsonObject(value) || !scan.root.members) {
    return notNotebook("The file is not a JSON object.");
  }
  const major = value.nbformat;
  const minor = value.nbformat_minor ?? 0;
  if (typeof major !== "number" || typeof minor !== "number") {
    return notNotebook("The file has no nbformat version.");
  }
  if (major !== 4) {
    return {
      ok: false,
      error: {
        kind: "unsupported-version",
        message: `Notebook format ${major}.${minor} is not supported; only version 4 is.`,
        nbformat: major,
        nbformatMinor: minor,
      },
    };
  }
  const rawCells = value.cells;
  const cellsSpan = scan.root.members.get("cells");
  if (!Array.isArray(rawCells) || !cellsSpan?.items) {
    return notNotebook("The notebook has no cell list.");
  }

  const format = detectFormat(text, scan.root, bom);
  const layout = layoutKey(format.indent, format.eol);
  const slice = (s: SpanNode) => text.slice(s.start, s.end);
  const remember = (v: JsonValue | undefined, s: SpanNode | undefined) => {
    if (v !== null && typeof v === "object" && s)
      rememberRaw(v, slice(s), layout);
  };

  const cells: NotebookCell[] = [];
  for (let i = 0; i < rawCells.length; i++) {
    const raw = rawCells[i];
    const span = cellsSpan.items[i];
    if (!isJsonObject(raw) || !span?.members || !span.keyOrder) {
      return notNotebook(`Cell ${i + 1} is not an object.`);
    }
    const cellType = raw.cell_type;
    if (typeof cellType !== "string" || !CELL_TYPES.has(cellType)) {
      return notNotebook(
        `Cell ${i + 1} has an unknown type ${JSON.stringify(cellType)}.`,
      );
    }
    const source = joinMultiline(raw.source ?? "");
    if (source === null) {
      return notNotebook(`Cell ${i + 1} has an invalid source.`);
    }
    const type = cellType as CellType;
    const members = span.members;

    const metadata = isJsonObject(raw.metadata) ? raw.metadata : {};
    remember(raw.metadata, members.get("metadata"));

    let attachments: JsonObject | null = null;
    if (type !== "code" && isJsonObject(raw.attachments)) {
      attachments = raw.attachments;
      remember(attachments, members.get("attachments"));
    }

    let outputs: NotebookOutput[] = [];
    if (type === "code" && Array.isArray(raw.outputs)) {
      const outSpan = members.get("outputs");
      outputs = raw.outputs.map((o, j) => {
        const out = normalizeOutput(o);
        const s = outSpan?.items?.[j];
        if (s) rememberRaw(out, slice(s), layout);
        return out;
      });
      if (outSpan) rememberRaw(outputs, slice(outSpan), layout);
    }

    const extra: Record<string, JsonValue> = {};
    for (const k of Object.keys(raw)) {
      if (CELL_KEYS.has(k)) continue;
      extra[k] = raw[k];
      remember(raw[k], members.get(k));
    }

    const cell: NotebookCell = {
      key: createKey(),
      id: typeof raw.id === "string" ? raw.id : null,
      cellType: type,
      source,
      metadata,
      attachments,
      outputs,
      executionCount:
        type === "code" && typeof raw.execution_count === "number"
          ? raw.execution_count
          : null,
      extra,
    };
    rememberRaw(cell, slice(span), layout);
    const sourceSpan = members.get("source");
    rememberCellOrigin(cell, {
      source,
      sourceText: sourceSpan ? slice(sourceSpan) : '""',
      keyOrder: span.keyOrder,
    });
    cells.push(cell);
  }
  rememberRaw(cells, slice(cellsSpan), layout);

  const metadata = isJsonObject(value.metadata) ? value.metadata : {};
  remember(value.metadata, scan.root.members.get("metadata"));
  const extra: Record<string, JsonValue> = {};
  for (const k of Object.keys(value)) {
    if (DOC_KEYS.has(k)) continue;
    extra[k] = value[k];
    remember(value[k], scan.root.members.get(k));
  }

  const doc: NotebookDocument = {
    nbformat: 4,
    nbformatMinor: minor,
    metadata,
    cells,
    extra,
    format,
    hadNonStandardNumbers: scan.nonStandard.length > 0,
  };
  rememberDocOrigin(doc, { keyOrder: scan.root.keyOrder ?? [] }, fileText);
  return { ok: true, doc };
}

function normalizeBundle(data: JsonValue | undefined): MimeBundle | null {
  if (data === undefined) return {};
  if (!isJsonObject(data)) return null;
  const out: Record<string, JsonValue> = {};
  for (const mime of Object.keys(data)) {
    const v = data[mime];
    out[mime] = isJsonMime(mime) ? v : (joinMultiline(v) ?? v);
  }
  return out;
}

function rest(o: JsonObject, known: readonly string[]): JsonObject {
  const out: Record<string, JsonValue> = {};
  for (const k of Object.keys(o)) if (!known.includes(k)) out[k] = o[k];
  return out;
}

function metadataOf(o: JsonObject): JsonObject | null {
  if (o.metadata === undefined) return {};
  return isJsonObject(o.metadata) ? o.metadata : null;
}

/** Reads one output; anything malformed is kept opaque, never dropped. */
export function normalizeOutput(o: JsonValue): NotebookOutput {
  const unknown = (): NotebookOutput => ({
    outputType: "unknown",
    raw: isJsonObject(o) ? o : { value: o },
  });
  if (!isJsonObject(o)) return unknown();
  switch (o.output_type) {
    case "stream": {
      const text = joinMultiline(o.text ?? "");
      if (text === null || typeof (o.name ?? "stdout") !== "string") {
        return unknown();
      }
      return {
        outputType: "stream",
        name: (o.name as string | undefined) ?? "stdout",
        text,
        extra: rest(o, ["output_type", "name", "text"]),
      };
    }
    case "display_data":
    case "execute_result": {
      const data = normalizeBundle(o.data);
      const metadata = metadataOf(o);
      if (!data || !metadata) return unknown();
      if (o.output_type === "display_data") {
        return {
          outputType: "display_data",
          data,
          metadata,
          displayId: null,
          extra: rest(o, ["output_type", "data", "metadata"]),
        };
      }
      return {
        outputType: "execute_result",
        executionCount:
          typeof o.execution_count === "number" ? o.execution_count : null,
        data,
        metadata,
        displayId: null,
        extra: rest(o, ["output_type", "data", "metadata", "execution_count"]),
      };
    }
    case "error": {
      const tb = o.traceback ?? [];
      if (
        !Array.isArray(tb) ||
        !tb.every((l) => typeof l === "string") ||
        typeof (o.ename ?? "") !== "string" ||
        typeof (o.evalue ?? "") !== "string"
      ) {
        return unknown();
      }
      return {
        outputType: "error",
        ename: (o.ename as string | undefined) ?? "",
        evalue: (o.evalue as string | undefined) ?? "",
        traceback: tb as string[],
        extra: rest(o, ["output_type", "ename", "evalue", "traceback"]),
      };
    }
    default:
      return unknown();
  }
}

function isSorted(keys: readonly string[]): boolean {
  for (let i = 1; i < keys.length; i++) if (keys[i - 1] > keys[i]) return false;
  return true;
}

function detectFormat(
  text: string,
  root: SpanNode,
  bom: boolean,
): NotebookFormat {
  const tail = text.slice(root.end);
  const trailingNewline: NotebookFormat["trailingNewline"] = tail.startsWith(
    "\r\n",
  )
    ? "\r\n"
    : tail.startsWith("\n")
      ? "\n"
      : "";
  const sortKeys =
    isSorted(root.keyOrder ?? []) &&
    (root.members?.get("cells")?.items ?? []).every((c) =>
      isSorted(c.keyOrder ?? []),
    );

  let i = root.start + 1;
  while (i < root.end && " \t\r\n".includes(text[i])) i++;
  const lead = text.slice(root.start + 1, i);
  if (text[i] === "}")
    return { ...DEFAULT_FORMAT, sortKeys, trailingNewline, bom };

  const nl = lead.lastIndexOf("\n");
  if (nl !== -1) {
    return {
      indent: lead.slice(nl + 1),
      compactSpaces: true,
      sortKeys,
      eol: lead[nl - 1] === "\r" ? "\r\n" : "\n",
      trailingNewline,
      bom,
    };
  }
  // One-line file: look at the separator after the first key.
  let j = i + 1;
  while (j < root.end) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === '"') break;
    else j++;
  }
  return {
    indent: null,
    compactSpaces: text.startsWith(": ", j + 1),
    sortKeys,
    eol: "\n",
    trailingNewline,
    bom,
  };
}
