import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEdit, createNotebook, type EditContext } from "./ops";
import { parseNotebook } from "./parse";
import { serializeNotebook } from "./serialize";
import type { NotebookDocument } from "./types";

// Fixtures and expected files are written by Python's json module with
// nbformat's writer settings, so these compare against Jupyter's own bytes.
const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

const parse = (text: string): NotebookDocument => {
  const r = parseNotebook(text);
  if (!r.ok) throw new Error(r.error.message);
  return r.doc;
};

const ctx: EditContext = {
  createKey: (() => {
    let n = 0;
    return () => `k${++n}`;
  })(),
  createId: () => "11111111",
};

const keyOf = (doc: NotebookDocument, id: string) => {
  const cell = doc.cells.find((c) => c.id === id);
  if (!cell) throw new Error(`no cell ${id}`);
  return cell.key;
};

describe("serializeNotebook", () => {
  it.each(["jupyter-4.5.ipynb", "jupyter-4.4-nan.ipynb"])(
    "writes an unedited %s back byte for byte",
    (name) => {
      const text = fixture(name);
      expect(serializeNotebook(parse(text))).toBe(text);
    },
  );

  it("matches Jupyter after editing a source, keeping 1.0 and big ints", () => {
    const doc = parse(fixture("jupyter-4.5.ipynb"));
    const { doc: next } = applyEdit(
      doc,
      {
        type: "setSource",
        key: keyOf(doc, "e5f6a7b8"),
        source: "x = 1\ny = 2\n",
      },
      ctx,
    );
    const out = serializeNotebook(next);
    expect(out).toBe(fixture("expected-set-source.ipynb"));
    expect(out).toContain('"ratio": 1.0');
    expect(out).toContain('"big": 12345678901234567890');
  });

  it("matches Jupyter after inserting a cell", () => {
    const doc = parse(fixture("jupyter-4.5.ipynb"));
    const { doc: next } = applyEdit(
      doc,
      { type: "insert", index: 1, cellType: "markdown", source: "New" },
      ctx,
    );
    expect(serializeNotebook(next)).toBe(fixture("expected-insert.ipynb"));
  });

  it("matches Jupyter after deleting a cell", () => {
    const doc = parse(fixture("jupyter-4.5.ipynb"));
    const { doc: next } = applyEdit(
      doc,
      { type: "delete", keys: [keyOf(doc, "deadbeef")] },
      ctx,
    );
    expect(serializeNotebook(next)).toBe(fixture("expected-delete.ipynb"));
  });

  it("matches Jupyter after clearing all outputs", () => {
    const doc = parse(fixture("jupyter-4.5.ipynb"));
    const { doc: next } = applyEdit(doc, { type: "clearOutputs" }, ctx);
    expect(serializeNotebook(next)).toBe(
      fixture("expected-clear-outputs.ipynb"),
    );
  });

  it("keeps bare NaN/Infinity in untouched outputs of a 4.4 notebook", () => {
    const doc = parse(fixture("jupyter-4.4-nan.ipynb"));
    expect(doc.hadNonStandardNumbers).toBe(true);
    const md = doc.cells[1];
    const { doc: next } = applyEdit(
      doc,
      { type: "setType", key: md.key, cellType: "raw" },
      ctx,
    );
    const out = serializeNotebook(next);
    expect(out).toBe(fixture("expected-4.4-to-raw.ipynb"));
    expect(out).toContain('"v": NaN');
  });

  it("re-reads its own output to the same model", () => {
    const doc = parse(fixture("jupyter-4.5.ipynb"));
    const { doc: edited } = applyEdit(doc, { type: "clearOutputs" }, ctx);
    const again = parse(serializeNotebook(edited));
    const strip = (d: NotebookDocument) =>
      d.cells.map(({ key: _key, ...rest }) => rest);
    expect(strip(again)).toEqual(strip(edited));
  });

  it("follows a file's own layout: tabs, CRLF, unsorted keys, no newline", () => {
    const text = [
      "{",
      '\t"nbformat": 4,',
      '\t"nbformat_minor": 2,',
      '\t"metadata": {},',
      '\t"cells": [',
      "\t\t{",
      '\t\t\t"source": "a",',
      '\t\t\t"metadata": {},',
      '\t\t\t"cell_type": "markdown"',
      "\t\t}",
      "\t]",
      "}",
    ].join("\r\n");
    const doc = parse(text);
    expect(doc.format).toMatchObject({
      indent: "\t",
      eol: "\r\n",
      sortKeys: false,
      trailingNewline: "",
    });
    const { doc: next } = applyEdit(
      doc,
      { type: "setSource", key: doc.cells[0].key, source: "b\nc" },
      ctx,
    );
    expect(serializeNotebook(next)).toBe(
      text.replace(
        '"source": "a"',
        '"source": [\r\n\t\t\t\t"b\\n",\r\n\t\t\t\t"c"\r\n\t\t\t]',
      ),
    );
  });

  it("writes one-line files on one line", () => {
    const text =
      '{"cells": [{"cell_type": "code", "execution_count": null, "metadata": {}, "outputs": [], "source": []}], "metadata": {}, "nbformat": 4, "nbformat_minor": 2}';
    const doc = parse(text);
    expect(doc.format.indent).toBeNull();
    const { doc: next } = applyEdit(
      doc,
      { type: "setSource", key: doc.cells[0].key, source: "x" },
      ctx,
    );
    expect(serializeNotebook(next)).toBe(
      text.replace('"source": []', '"source": ["x"]'),
    );
  });

  it("writes a new notebook as Jupyter would", () => {
    expect(serializeNotebook(createNotebook(ctx))).toBe(
      `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "id": "11111111",
   "metadata": {},
   "outputs": [],
   "source": []
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`,
    );
  });

  it("keeps a byte order mark", () => {
    const text = `﻿{\n "cells": [],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 5\n}\n`;
    const doc = parse(text);
    const { doc: next } = applyEdit(
      doc,
      { type: "insert", index: 0, cellType: "raw" },
      ctx,
    );
    const out = serializeNotebook(next);
    expect(out.startsWith('﻿{\n "cells": [\n  {\n   "cell_type": "raw"')).toBe(
      true,
    );
  });
});
