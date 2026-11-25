import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scanJson } from "./json";
import { splitLines } from "./lines";
import { normalizeOutput, parseNotebook } from "./parse";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

describe("parseNotebook", () => {
  it("reads cells, outputs and metadata of a Jupyter 4.5 notebook", () => {
    const r = parseNotebook(fixture("jupyter-4.5.ipynb"));
    if (!r.ok) throw new Error(r.error.message);
    const { doc } = r;
    expect(doc.nbformatMinor).toBe(5);
    expect(doc.metadata.kernelspec).toMatchObject({ name: "python3" });
    expect(doc.cells.map((c) => [c.id, c.cellType])).toEqual([
      ["a1b2c3d4", "markdown"],
      ["e5f6a7b8", "code"],
      ["0badc0de", "code"],
      ["deadbeef", "code"],
      ["feedface", "raw"],
      ["c0ffee00", "code"],
    ]);
    const [md, code, df, err, raw, empty] = doc.cells;
    expect(md.source).toBe(
      "# Analysis — résumé 📈\n\nSome *markdown* with ![img](attachment:dot.png)",
    );
    expect(md.attachments).toHaveProperty("dot.png");
    expect(code.executionCount).toBe(1);
    expect(code.outputs).toMatchObject([
      { outputType: "stream", name: "stdout", text: "hello\nworld\n" },
      { outputType: "stream", name: "stderr" },
    ]);
    expect(df.outputs[0]).toMatchObject({
      outputType: "execute_result",
      executionCount: 2,
      data: {
        "text/html": "<table>\n<tr><td>1</td></tr>\n</table>",
        "application/json": { a: [1, 2.5], nested: { x: null } },
      },
    });
    expect(df.outputs[1]).toMatchObject({
      outputType: "display_data",
      metadata: { "image/png": { width: 640 } },
    });
    expect(err.outputs[0]).toMatchObject({
      outputType: "error",
      ename: "ZeroDivisionError",
    });
    expect(err.outputs[1]).toMatchObject({ outputType: "unknown" });
    expect(raw.source).toBe("");
    expect(empty.executionCount).toBeNull();
    expect(new Set(doc.cells.map((c) => c.key)).size).toBe(6);
  });

  it("reads 4.4 notebooks without ids and with bare NaN", () => {
    const r = parseNotebook(fixture("jupyter-4.4-nan.ipynb"));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.doc.cells.every((c) => c.id === null)).toBe(true);
    expect(r.doc.hadNonStandardNumbers).toBe(true);
    expect(r.doc.cells[0].outputs[0]).toMatchObject({
      data: { "application/json": { v: null, w: null } },
    });
    expect(r.doc.cells[1].source).toBe("Line one\r\nLine two\rthree");
  });

  it.each([
    ["not json", "invalid-json"],
    ["[1, 2]", "not-notebook"],
    ['{"cells": []}', "not-notebook"],
    ['{"nbformat": 4, "nbformat_minor": 5}', "not-notebook"],
    ['{"nbformat": 4, "cells": [{"cell_type": "chart"}]}', "not-notebook"],
    [
      '{"nbformat": 4, "cells": [{"cell_type": "code", "source": 3}]}',
      "not-notebook",
    ],
    [
      '{"nbformat": 3, "nbformat_minor": 0, "worksheets": []}',
      "unsupported-version",
    ],
    [
      '{"nbformat": 5, "nbformat_minor": 0, "cells": []}',
      "unsupported-version",
    ],
  ])("rejects %s as %s", (text, kind) => {
    const r = parseNotebook(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe(kind);
  });

  it("names the failing cell", () => {
    const r = parseNotebook(
      '{"nbformat": 4, "nbformat_minor": 5, "cells": [{"cell_type": "code", "source": ""}, 7]}',
    );
    expect(r.ok || r.error.message).toBe("Cell 2 is not an object.");
  });

  it("fills members missing from a sloppy file", () => {
    const r = parseNotebook(
      '{"nbformat": 4, "cells": [{"cell_type": "code", "source": "x"}]}',
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(r.doc.nbformatMinor).toBe(0);
    expect(r.doc.cells[0]).toMatchObject({
      metadata: {},
      outputs: [],
      executionCount: null,
    });
  });
});

describe("normalizeOutput", () => {
  it("keeps malformed outputs opaque instead of dropping them", () => {
    expect(normalizeOutput({ output_type: "stream", text: 5 })).toEqual({
      outputType: "unknown",
      raw: { output_type: "stream", text: 5 },
    });
    expect(
      normalizeOutput({ output_type: "error", traceback: "x" }),
    ).toMatchObject({
      outputType: "unknown",
    });
    expect(normalizeOutput("text")).toEqual({
      outputType: "unknown",
      raw: { value: "text" },
    });
  });

  it("keeps base64 images as one string and joins text types", () => {
    const out = normalizeOutput({
      output_type: "display_data",
      data: { "image/png": "abc\n", "text/plain": ["a\n", "b"] },
    });
    expect(out).toMatchObject({
      data: { "image/png": "abc\n", "text/plain": "a\nb" },
      metadata: {},
      displayId: null,
    });
  });
});

describe("splitLines", () => {
  it.each([
    ["", []],
    ["a", ["a"]],
    ["a\n", ["a\n"]],
    ["a\nb", ["a\n", "b"]],
    ["a\r\nb\rc", ["a\r\n", "b\r", "c"]],
    ["a b\x0cc", ["a ", "b\x0c", "c"]],
    ["\n\n", ["\n", "\n"]],
  ])("splits %j like Python's splitlines(True)", (text, lines) => {
    expect(splitLines(text)).toEqual(lines);
  });
});

describe("scanJson", () => {
  it("records spans to the given depth and skips deeper values", () => {
    const text = '{"a": [1, {"b": [2]}], "c": "x\\"}"}';
    const { root } = scanJson(text, 2);
    const a = root.members?.get("a");
    expect(a && text.slice(a.start, a.end)).toBe('[1, {"b": [2]}]');
    const inner = a?.items?.[1];
    expect(inner && text.slice(inner.start, inner.end)).toBe('{"b": [2]}');
    expect(inner?.members).toBeUndefined();
    const c = root.members?.get("c");
    expect(c && text.slice(c.start, c.end)).toBe('"x\\"}"');
    expect(root.keyOrder).toEqual(["a", "c"]);
  });

  it("finds NaN and Infinity outside strings at any depth", () => {
    const text = '{"a": NaN, "b": [[-Infinity]], "s": "NaN"}';
    const { nonStandard } = scanJson(text, 1);
    expect(nonStandard.map((t) => text.slice(t.start, t.end))).toEqual([
      "NaN",
      "-Infinity",
    ]);
  });

  it("handles escaped backslashes before a closing quote", () => {
    const text = '{"k": "a\\\\", "n": 1}';
    expect(scanJson(text, 1).root.keyOrder).toEqual(["k", "n"]);
  });

  it("does not overflow on deeply nested values", () => {
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    expect(() => scanJson(`{"d": ${deep}}`, 4)).not.toThrow();
  });

  it.each(['{"a": 1', '{"a" 1}', '{"a": 1} x', '"abc'])(
    "rejects %s",
    (text) => {
      expect(() => scanJson(text, 4)).toThrow(SyntaxError);
    },
  );
});
