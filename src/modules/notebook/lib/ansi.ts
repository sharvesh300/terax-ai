// Terminal-style output (streams, tracebacks) as styled text. Handles SGR
// colours and attributes, carriage returns and backspaces (progress bars),
// and erase-in-line; every other escape sequence is dropped.

export type AnsiStyle = {
  readonly fg?: string;
  readonly bg?: string;
  readonly bold?: true;
  readonly dim?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly strike?: true;
  readonly inverse?: true;
};

export type AnsiSegment = {
  readonly text: string;
  readonly style: AnsiStyle | null;
};

const NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
];

/** The terminal theme's palette, so output follows the user's colours. */
function paletteColor(i: number): string {
  return i < 8
    ? `var(--terminal-ansi-${NAMES[i]})`
    : `var(--terminal-ansi-bright-${NAMES[i - 8]})`;
}

const CUBE = [0, 95, 135, 175, 215, 255];

function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return paletteColor(n);
  if (n < 232) {
    const i = n - 16;
    const r = CUBE[Math.floor(i / 36)];
    const g = CUBE[Math.floor(i / 6) % 6];
    const b = CUBE[i % 6];
    return `rgb(${r}, ${g}, ${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v}, ${v}, ${v})`;
}

const byte = (n: number | undefined) =>
  n !== undefined && Number.isInteger(n) && n >= 0 && n <= 255;

type Mutable = { -readonly [K in keyof AnsiStyle]: AnsiStyle[K] };

/** Applies one SGR parameter list (`ESC [ … m`) to `style`. */
export function applySgr(
  style: AnsiStyle | null,
  params: readonly number[],
): AnsiStyle | null {
  let s: Mutable = { ...style };
  const list = params.length === 0 ? [0] : params;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p === 0) s = {};
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4 || p === 21) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 22) {
      delete s.bold;
      delete s.dim;
    } else if (p === 23) delete s.italic;
    else if (p === 24) delete s.underline;
    else if (p === 27) delete s.inverse;
    else if (p === 29) delete s.strike;
    else if (p >= 30 && p <= 37) s.fg = paletteColor(p - 30);
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = paletteColor(p - 40);
    else if (p === 49) delete s.bg;
    else if (p >= 90 && p <= 97) s.fg = paletteColor(p - 90 + 8);
    else if (p >= 100 && p <= 107) s.bg = paletteColor(p - 100 + 8);
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (list[i + 1] === 5) {
        const c = color256(list[i + 2]);
        if (c) s[key] = c;
        i += 2;
      } else if (list[i + 1] === 2) {
        const [r, g, b] = [list[i + 2], list[i + 3], list[i + 4]];
        if (byte(r) && byte(g) && byte(b)) s[key] = `rgb(${r}, ${g}, ${b})`;
        i += 4;
      }
    }
  }
  return Object.keys(s).length === 0 ? null : s;
}

// One escape sequence: CSI (with final byte), OSC (to BEL or ST), an escape
// with intermediates (`ESC ( B` charset selects), or a two-character escape.
const ESCAPE =
  /\x1b\[([0-?]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b(?:[ -/]+[0-~]|[@-Z\\-_])?/g;

type Cell = { ch: string; style: AnsiStyle | null };

/**
 * Parses terminal output into styled segments. Line breaks stay in the
 * text. Within a line, `\r` returns to column 0 and `\b` steps back, and
 * later text overwrites earlier text, as on a terminal.
 */
export function parseAnsi(text: string): AnsiSegment[] {
  const out: AnsiSegment[] = [];
  let style: AnsiStyle | null = null;

  const push = (t: string, s: AnsiStyle | null) => {
    if (t === "") return;
    const last = out[out.length - 1];
    if (last && last.style === s) {
      out[out.length - 1] = { text: last.text + t, style: s };
    } else out.push({ text: t, style: s });
  };

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) push("\n", null);
    const line = lines[li];
    const needsCells =
      line.includes("\r") || line.includes("\b") || /\x1b\[[0-2]?K/.test(line);

    if (!needsCells) {
      let last = 0;
      for (const m of line.matchAll(ESCAPE)) {
        push(line.slice(last, m.index), style);
        if (m[3] === "m" && m[2] === "")
          style = applySgr(style, parseParams(m[1]));
        last = (m.index ?? 0) + m[0].length;
      }
      push(line.slice(last), style);
      continue;
    }

    // Overwrite semantics: a small cell buffer for this line only.
    const cells: Cell[] = [];
    let col = 0;
    const write = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r") col = 0;
        else if (ch === "\b") col = Math.max(0, col - 1);
        else {
          cells[col] = { ch, style };
          col++;
        }
      }
    };
    let last = 0;
    for (const m of line.matchAll(ESCAPE)) {
      write(line.slice(last, m.index));
      if (m[3] === "m" && m[2] === "")
        style = applySgr(style, parseParams(m[1]));
      else if (m[3] === "K") {
        const mode = m[1] === "" ? 0 : Number(m[1]);
        if (mode === 0) cells.length = Math.min(cells.length, col);
        else if (mode === 1)
          for (let i = 0; i <= col && i < cells.length; i++)
            cells[i] = { ch: " ", style: null };
        else if (mode === 2) cells.length = 0;
      }
      last = (m.index ?? 0) + m[0].length;
    }
    write(line.slice(last));
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i] ?? { ch: " ", style: null };
      push(c.ch, c.style);
    }
  }
  return out;
}

function parseParams(raw: string): number[] {
  if (raw === "") return [];
  // Colon sub-parameters (38:2::r:g:b) are read like semicolons.
  return raw
    .replace(/:+/g, ";")
    .split(";")
    .map((p) => (p === "" ? 0 : Number(p)))
    .filter((n) => Number.isFinite(n));
}

/** Inline CSS for a style; inverse swaps colours against the theme's own. */
export function ansiCss(
  style: AnsiStyle | null,
): Record<string, string> | undefined {
  if (!style) return undefined;
  const css: Record<string, string> = {};
  let fg = style.fg;
  let bg = style.bg;
  if (style.inverse) {
    [fg, bg] = [
      bg ?? "var(--color-background)",
      fg ?? "var(--color-foreground)",
    ];
  }
  if (fg) css.color = fg;
  if (bg) css.backgroundColor = bg;
  if (style.bold) css.fontWeight = "600";
  if (style.dim) css.opacity = "0.7";
  if (style.italic) css.fontStyle = "italic";
  const lines = [style.underline && "underline", style.strike && "line-through"]
    .filter(Boolean)
    .join(" ");
  if (lines) css.textDecoration = lines;
  return Object.keys(css).length === 0 ? undefined : css;
}
