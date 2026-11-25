// Pure helpers for showing a notebook read-only. Rich output (HTML, JS,
// widgets) and ANSI colours come later; this is the safe baseline.

import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type MimeBundle,
  type NotebookOutput,
} from "../model";

const BASE64_IMAGES = new Set(["image/png", "image/jpeg", "image/gif"]);

// Most specific first. Only types this view can show without running code.
const DISPLAY_ORDER = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/svg+xml",
  "text/plain",
] as const;

export type DisplayMime = (typeof DISPLAY_ORDER)[number];

/** The richest MIME type in a bundle that this view can show, if any. */
export function pickDisplayMime(data: MimeBundle): DisplayMime | null {
  for (const mime of DISPLAY_ORDER) {
    if (typeof data[mime] === "string") return mime;
  }
  return null;
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

// CSI (colours, cursor moves) and OSC (titles, hyperlinks) sequences.
const ANSI =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI, "") : text;
}

/**
 * Applies carriage returns the way a terminal shows them: text after a `\r`
 * overwrites its line, so progress bars show their final state only.
 */
export function applyCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      let out = "";
      for (const part of line.split("\r")) {
        out = part + out.slice(part.length);
      }
      return out;
    })
    .join("\n");
}

/** Terminal-ish output text (streams, tracebacks) as plain text. */
export function terminalText(text: string): string {
  return applyCarriageReturns(stripAnsi(text));
}

export function errorText(
  o: Extract<NotebookOutput, { outputType: "error" }>,
): string {
  if (o.traceback.length > 0) return terminalText(o.traceback.join("\n"));
  return o.evalue ? `${o.ename}: ${o.evalue}` : o.ename;
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
