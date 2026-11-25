// Pure helpers for showing a notebook read-only. Nothing in an output runs:
// HTML is sanitized, SVG goes through <img>, JavaScript and widgets fall back
// to their text form.

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MimeBundle,
  type NotebookOutput,
} from "../model";
import { hasScripts, MAX_HTML_CHARS } from "./html";

const BASE64_IMAGES = new Set(["image/png", "image/jpeg", "image/gif"]);

// Richest first, as JupyterLab ranks them, limited to what this view shows.
const DISPLAY_ORDER = [
  "text/html",
  "text/markdown",
  "text/latex",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "application/json",
  "text/plain",
] as const;

export type DisplayMime = (typeof DISPLAY_ORDER)[number];

function usable(mime: DisplayMime, value: JsonValue | undefined): boolean {
  if (value === undefined) return false;
  if (mime === "application/json") return true;
  if (typeof value !== "string") return false;
  return mime !== "text/html" || value.length <= MAX_HTML_CHARS;
}

/**
 * The richest MIME type in a bundle that this view can show, if any. HTML
 * that needs scripts (Plotly, Bokeh, widgets) is a blank box without them, so
 * any other form wins; it is used only when nothing else exists.
 */
export function pickDisplayMime(data: MimeBundle): DisplayMime | null {
  let scripted: DisplayMime | null = null;
  for (const mime of DISPLAY_ORDER) {
    const value = data[mime];
    if (!usable(mime, value)) continue;
    if (mime === "text/html" && hasScripts(value as string)) {
      scripted = mime;
      continue;
    }
    return mime;
  }
  return scripted;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * An `<img>` source for an image output. SVG goes through `<img>` too, where
 * its scripts never run and it cannot load anything.
 */
export function imageSrc(mime: string, value: JsonValue): string | null {
  if (typeof value !== "string") return null;
  if (mime === "image/svg+xml") {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(value)}`;
  }
  if (!BASE64_IMAGES.has(mime)) return null;
  const b64 = value.replace(/\s+/g, "");
  if (b64.length === 0 || !BASE64.test(b64)) return null;
  return `data:${mime};base64,${b64}`;
}

/** A traceback as terminal text (ANSI colours kept for the renderer). */
export function errorText(
  o: Extract<NotebookOutput, { outputType: "error" }>,
): string {
  if (o.traceback.length > 0) return o.traceback.join("\n");
  return o.evalue ? `${o.ename}: ${o.evalue}` : o.ename;
}

/**
 * Consecutive chunks of one stream as one output, as Jupyter shows them
 * (files written mid-run can hold them apart).
 */
export function mergeStreams(
  outputs: readonly NotebookOutput[],
): NotebookOutput[] {
  const out: NotebookOutput[] = [];
  for (const o of outputs) {
    const last = out[out.length - 1];
    if (
      o.outputType === "stream" &&
      last?.outputType === "stream" &&
      last.name === o.name
    ) {
      out[out.length - 1] = { ...last, text: last.text + o.text };
    } else out.push(o);
  }
  return out;
}

export type CellView = {
  readonly sourceHidden: boolean;
  readonly outputsHidden: boolean;
  /** Long outputs scroll in a box instead of growing the page. */
  readonly scrolled: boolean;
};

/** JupyterLab's (`jupyter.*_hidden`) and classic Notebook's view flags. */
export function cellView(metadata: JsonObject): CellView {
  const jupyter = isJsonObject(metadata.jupyter) ? metadata.jupyter : {};
  return {
    sourceHidden: jupyter.source_hidden === true,
    outputsHidden:
      jupyter.outputs_hidden === true || metadata.collapsed === true,
    scrolled: metadata.scrolled === true,
  };
}

export type ClippedText = {
  readonly text: string;
  readonly hiddenLines: number;
};

/** The first `maxLines` lines of `text`; long outputs expand on request. */
export function clipLines(text: string, maxLines: number): ClippedText {
  // A trailing newline ends the last line; it does not start a hidden one.
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  let pos = -1;
  for (let i = 0; i < maxLines; i++) {
    pos = body.indexOf("\n", pos + 1);
    if (pos === -1) return { text, hiddenLines: 0 };
  }
  let hidden = 1;
  for (
    let i = body.indexOf("\n", pos + 1);
    i !== -1;
    i = body.indexOf("\n", i + 1)
  ) {
    hidden++;
  }
  return { text: body.slice(0, pos), hiddenLines: hidden };
}

const str = (v: JsonValue | undefined) =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** "Python 3 (ipykernel)" or the language name, from notebook metadata. */
export function kernelLabel(metadata: JsonObject): string | null {
  const spec = metadata.kernelspec;
  const info = metadata.language_info;
  const fromSpec = isJsonObject(spec)
    ? (str(spec.display_name) ?? str(spec.language))
    : null;
  return fromSpec ?? (isJsonObject(info) ? str(info.name) : null);
}

/**
 * React keys that survive a reload of the file: the cell id when it is
 * unique, else the position. Parsed keys are fresh on every read, which
 * would remount every cell each time the file changes on disk.
 */
export function renderKeys(
  cells: readonly { readonly id: string | null }[],
): string[] {
  const seen = new Set<string>();
  return cells.map((c, i) => {
    const key =
      c.id !== null && !seen.has(`id:${c.id}`) ? `id:${c.id}` : `at:${i}`;
    seen.add(key);
    return key;
  });
}

// Kernel language names that differ from the highlighter's names.
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  ipython: "python",
  ipython3: "python",
  python3: "python",
  "c++": "cpp",
  "c++11": "cpp",
  "c++14": "cpp",
  "c++17": "cpp",
  "c++20": "cpp",
  "c#": "csharp",
  "f#": "fsharp",
  ts: "typescript",
  js: "javascript",
};

/** The language of a notebook's code cells, from its metadata. */
export function notebookLanguage(metadata: JsonObject): string | null {
  const info = metadata.language_info;
  const spec = metadata.kernelspec;
  const raw =
    (isJsonObject(info) ? str(info.name) : null) ??
    (isJsonObject(spec) ? str(spec.language) : null);
  if (raw === null) return null;
  const lower = raw.toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}
