import type { JsonValue } from "./json";

// Python's str.splitlines boundaries, which nbformat uses to save multiline
// strings (`splitlines(keepends=True)`).
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/g;

/** Splits like Python's `s.splitlines(True)`: line breaks stay attached. */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of text.matchAll(LINE_BREAK)) {
    const end = (m.index ?? 0) + m[0].length;
    out.push(text.slice(last, end));
    last = end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Reads nbformat's multiline string (a string or a list of strings). */
export function joinMultiline(value: JsonValue | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value.join("");
  }
  return null;
}

export function isJsonMime(mime: string): boolean {
  return mime === "application/json" || mime.endsWith("+json");
}

// nbformat's `_split_mimebundle`: text types plus these two are saved as line
// lists; everything else (base64 images) stays one string.
const SPLIT_NON_TEXT = new Set(["application/javascript", "image/svg+xml"]);

export function shouldSplitMime(mime: string): boolean {
  return (
    !isJsonMime(mime) && (mime.startsWith("text/") || SPLIT_NON_TEXT.has(mime))
  );
}
