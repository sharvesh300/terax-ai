// JSON helpers for lossless notebook round trips.
//
// `JSON.parse` loses formatting details a notebook's git history cares about
// (`1.0` becomes `1`, integers past 2^53 lose precision, key order of numeric
// keys changes). The scanner below records the source span of every value down
// to a fixed depth so that untouched parts are written back byte for byte.

type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { readonly [key: string]: JsonValue };
type JsonArray = readonly JsonValue[];

export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type SpanNode = {
  readonly start: number;
  readonly end: number;
  /** Object members in source order (last duplicate wins, like JSON.parse). */
  readonly members?: ReadonlyMap<string, SpanNode>;
  readonly keyOrder?: readonly string[];
  readonly items?: readonly SpanNode[];
};

export type ScanResult = {
  readonly root: SpanNode;
  /** Offsets of bare `NaN` / `Infinity` / `-Infinity` tokens (Python's json writes them). */
  readonly nonStandard: readonly { start: number; end: number }[];
};

const WS = new Set([" ", "\t", "\n", "\r"]);

/**
 * Records spans for containers nested less than `maxDepth` deep; deeper
 * values are skipped iteratively, so pathological nesting cannot overflow the
 * stack. Assumes structurally valid JSON (apart from non-standard numbers);
 * throws on anything it cannot follow.
 */
export function scanJson(text: string, maxDepth: number): ScanResult {
  const nonStandard: { start: number; end: number }[] = [];
  let pos = 0;

  const fail = (what: string): never => {
    throw new SyntaxError(`Invalid JSON at offset ${pos}: ${what}`);
  };
  const skipWs = () => {
    while (pos < text.length && WS.has(text[pos])) pos++;
  };
  const skipString = () => {
    // pos is on the opening quote.
    let i = pos + 1;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) fail("unterminated string");
      let bs = 0;
      for (let j = q - 1; text.charCodeAt(j) === 92; j--) bs++;
      if (bs % 2 === 0) {
        pos = q + 1;
        return;
      }
      i = q + 1;
    }
  };
  const readKey = (): string => {
    const start = pos;
    if (text[pos] !== '"') fail("expected key");
    skipString();
    return JSON.parse(text.slice(start, pos)) as string;
  };
  const skipPrimitive = () => {
    const start = pos;
    while (pos < text.length) {
      const c = text[pos];
      if (c === "," || c === "}" || c === "]" || WS.has(c)) break;
      pos++;
    }
    if (pos === start) fail("expected value");
    const tok = text.slice(start, pos);
    if (tok === "NaN" || tok === "Infinity" || tok === "-Infinity") {
      nonStandard.push({ start, end: pos });
    }
  };
  // Skips one container without recursion.
  const skipContainer = () => {
    let depth = 0;
    while (pos < text.length) {
      const c = text[pos];
      if (c === '"') {
        skipString();
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          pos++;
          return;
        }
      } else if (c === "N" || c === "I") {
        const start = text[pos - 1] === "-" ? pos - 1 : pos;
        const word = c === "N" ? "NaN" : "Infinity";
        if (text.startsWith(word, pos)) {
          nonStandard.push({ start, end: pos + word.length });
          pos += word.length;
          continue;
        }
      }
      pos++;
    }
    fail("unterminated container");
  };

  const value = (depth: number): SpanNode => {
    skipWs();
    const start = pos;
    const c = text[pos];
    if (c === '"') {
      skipString();
      return { start, end: pos };
    }
    if (c !== "{" && c !== "[") {
      skipPrimitive();
      return { start, end: pos };
    }
    if (depth >= maxDepth) {
      skipContainer();
      return { start, end: pos };
    }
    pos++;
    if (c === "{") {
      const members = new Map<string, SpanNode>();
      const keyOrder: string[] = [];
      skipWs();
      if (text[pos] === "}") {
        pos++;
        return { start, end: pos, members, keyOrder };
      }
      for (;;) {
        skipWs();
        const key = readKey();
        skipWs();
        if (text[pos] !== ":") fail("expected ':'");
        pos++;
        const child = value(depth + 1);
        if (!members.has(key)) keyOrder.push(key);
        members.set(key, child);
        skipWs();
        if (text[pos] === ",") {
          pos++;
          continue;
        }
        if (text[pos] === "}") {
          pos++;
          return { start, end: pos, members, keyOrder };
        }
        fail("expected ',' or '}'");
      }
    }
    const items: SpanNode[] = [];
    skipWs();
    if (text[pos] === "]") {
      pos++;
      return { start, end: pos, items };
    }
    for (;;) {
      items.push(value(depth + 1));
      skipWs();
      if (text[pos] === ",") {
        pos++;
        continue;
      }
      if (text[pos] === "]") {
        pos++;
        return { start, end: pos, items };
      }
      fail("expected ',' or ']'");
    }
  };

  const root = value(0);
  skipWs();
  if (pos !== text.length) fail("trailing characters");
  return { root, nonStandard };
}

/** Parses JSON that may contain Python's bare NaN/Infinity (read as null). */
export function parseLenient(
  text: string,
  nonStandard: ScanResult["nonStandard"],
): JsonValue {
  if (nonStandard.length === 0) return JSON.parse(text) as JsonValue;
  let out = "";
  let last = 0;
  for (const t of nonStandard) {
    out += `${text.slice(last, t.start)}null`;
    last = t.end;
  }
  out += text.slice(last);
  return JSON.parse(out) as JsonValue;
}

// ---------------------------------------------------------------------------
// Writing

export type JsonFormat = {
  /** Indent unit; `null` writes everything on one line. */
  readonly indent: string | null;
  /** One-line mode only: Python's default `", "` / `": "` separators. */
  readonly compactSpaces: boolean;
  readonly sortKeys: boolean;
  readonly eol: "\n" | "\r\n";
};

/** Verbatim JSON text spliced into the output. */
export class RawJson {
  constructor(readonly text: string) {}
}

/** An object whose members are written in exactly this order. */
export class OrderedObject {
  constructor(readonly entries: readonly (readonly [string, WritableJson])[]) {}
}

export type WritableJson =
  | JsonPrimitive
  | RawJson
  | OrderedObject
  | readonly WritableJson[]
  | { readonly [key: string]: WritableJson };

/**
 * Writes JSON the way Python's `json.dumps(indent=…, sort_keys=…,
 * ensure_ascii=False)` does, which is how Jupyter saves notebooks.
 * `lookupRaw` lets callers splice the original text of untouched values.
 */
export function writeJson(
  value: WritableJson,
  format: JsonFormat,
  lookupRaw: (v: object) => string | undefined = () => undefined,
  level = 0,
): string {
  const { indent, eol } = format;
  const pad = (n: number) => (indent === null ? "" : indent.repeat(n));
  const itemSep =
    indent === null ? (format.compactSpaces ? ", " : ",") : `,${eol}`;
  const keySep = indent === null && !format.compactSpaces ? ":" : ": ";

  const write = (v: WritableJson, lvl: number): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (v instanceof RawJson) return v.text;
    const raw = lookupRaw(v);
    if (raw !== undefined) return raw;

    let parts: string[];
    let open: string;
    let close: string;
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      parts = v.map((item) => write(item, lvl + 1));
      open = "[";
      close = "]";
    } else {
      let entries: (readonly [string, WritableJson])[];
      if (v instanceof OrderedObject) {
        entries = [...v.entries];
      } else {
        const obj = v as { readonly [key: string]: WritableJson };
        entries = Object.keys(obj).map((k) => [k, obj[k]] as const);
      }
      if (format.sortKeys) {
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      }
      if (entries.length === 0) return "{}";
      parts = entries.map(
        ([k, val]) => `${JSON.stringify(k)}${keySep}${write(val, lvl + 1)}`,
      );
      open = "{";
      close = "}";
    }
    if (indent === null) return open + parts.join(itemSep) + close;
    const inner = pad(lvl + 1);
    return `${open}${eol}${inner}${parts.join(itemSep + inner)}${eol}${pad(lvl)}${close}`;
  };

  return write(value, level);
}
