import { describe, expect, it } from "vitest";
import { ansiCss, applySgr, parseAnsi } from "./ansi";

const plain = (text: string) =>
  parseAnsi(text)
    .map((s) => s.text)
    .join("");

describe("parseAnsi", () => {
  it("splits colours into styled segments in the terminal palette", () => {
    expect(parseAnsi("ok \x1b[31mred\x1b[0m done")).toEqual([
      { text: "ok ", style: null },
      { text: "red", style: { fg: "var(--terminal-ansi-red)" } },
      { text: " done", style: null },
    ]);
    expect(parseAnsi("\x1b[1;92mB")[0].style).toEqual({
      bold: true,
      fg: "var(--terminal-ansi-bright-green)",
    });
  });

  it("carries styles across lines until reset", () => {
    const segs = parseAnsi("\x1b[33ma\nb\x1b[0m\nc");
    expect(segs).toEqual([
      { text: "a", style: { fg: "var(--terminal-ansi-yellow)" } },
      { text: "\n", style: null },
      { text: "b", style: { fg: "var(--terminal-ansi-yellow)" } },
      { text: "\nc", style: null },
    ]);
  });

  it("overwrites on carriage return and backspace, as a terminal does", () => {
    expect(plain("10%\r50%\r100%\ndone")).toBe("100%\ndone");
    expect(plain("abcdef\rXY")).toBe("XYcdef");
    expect(plain("ab\bc")).toBe("ac");
    expect(plain("a\r\nb")).toBe("a\nb");
    // tqdm: return, redraw, erase the rest of the line.
    expect(plain("long text\rshort\x1b[K")).toBe("short");
  });

  it("keeps colours through overwrites", () => {
    const segs = parseAnsi("\x1b[32m 50%\x1b[0m\r\x1b[32m100%\x1b[0m");
    expect(segs).toEqual([
      { text: "100%", style: { fg: "var(--terminal-ansi-green)" } },
    ]);
  });

  it("drops cursor moves, titles and hyperlinks", () => {
    expect(
      plain("\x1b[2Ja\x1b]0;title\x07b\x1b]8;;https://x\x1b\\c\x1b]8;;\x1b\\"),
    ).toBe("abc");
    expect(plain("\x1b(Bq")).toBe("q");
  });

  it("does not choke on a stray escape", () => {
    expect(plain("a\x1b")).toBe("a");
  });
});

describe("applySgr", () => {
  it("reads 256-colour and true colour, ignoring bad values", () => {
    expect(applySgr(null, [38, 5, 196])).toEqual({ fg: "rgb(255, 0, 0)" });
    expect(applySgr(null, [48, 5, 244])).toEqual({ bg: "rgb(128, 128, 128)" });
    expect(applySgr(null, [38, 5, 4])).toEqual({
      fg: "var(--terminal-ansi-blue)",
    });
    expect(applySgr(null, [38, 2, 10, 20, 30])).toEqual({
      fg: "rgb(10, 20, 30)",
    });
    expect(applySgr(null, [38, 2, 999, 0, 0])).toBeNull();
    expect(applySgr(null, [38, 5, 300])).toBeNull();
  });

  it("turns attributes on and off", () => {
    const s = applySgr(null, [1, 3, 4, 9]);
    expect(s).toEqual({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
    });
    expect(applySgr(s, [22, 23, 24, 29])).toBeNull();
    expect(applySgr({ fg: "x" }, [])).toBeNull();
    expect(applySgr({ fg: "x", bg: "y" }, [39])).toEqual({ bg: "y" });
  });
});

describe("ansiCss", () => {
  it("swaps colours for inverse against the theme", () => {
    expect(ansiCss({ inverse: true, fg: "red" })).toEqual({
      color: "var(--color-background)",
      backgroundColor: "red",
    });
    expect(ansiCss({ underline: true, strike: true, dim: true })).toEqual({
      textDecoration: "underline line-through",
      opacity: "0.7",
    });
    expect(ansiCss(null)).toBeUndefined();
  });
});
