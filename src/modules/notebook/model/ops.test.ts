import { describe, expect, it } from "vitest";
import {
  applyExecutionToHistory,
  canRedo,
  canUndo,
  commitEdit,
  createHistory,
  isDirty,
  markSaved,
  redo,
  undo,
} from "./history";
import {
  applyEdit,
  applyExecution,
  createNotebook,
  type EditContext,
} from "./ops";
import { parseNotebook } from "./parse";
import { serializeNotebook } from "./serialize";
import type { NotebookDocument, NotebookOutput } from "./types";

function context(): EditContext {
  let k = 0;
  let id = 0;
  return {
    createKey: () => `k${++k}`,
    createId: (taken) => {
      let next: string;
      do next = `id${++id}`;
      while (taken.has(next));
      return next;
    },
  };
}

const stream = (text: string, name = "stdout"): NotebookOutput => ({
  outputType: "stream",
  name,
  text,
  extra: {},
});

/** Three code cells "a", "b", "c" with keys k1..k3 (k4.. for new ones). */
function threeCells(minor = 5) {
  const ctx = context();
  const cells = ["a", "b", "c"].map((source, i) => ({
    key: ctx.createKey(),
    id: minor >= 5 ? `c${i}` : null,
    cellType: "code" as const,
    source,
    metadata: {},
    attachments: null,
    outputs: [stream(`${source}!`)],
    executionCount: i + 1,
    extra: {},
  }));
  const doc: NotebookDocument = {
    ...createNotebook(context()),
    nbformatMinor: minor,
    cells,
  };
  return { doc, ctx };
}

const sources = (doc: NotebookDocument) => doc.cells.map((c) => c.source);

describe("applyEdit", () => {
  it("inserts a cell with a fresh id and focuses it", () => {
    const { doc, ctx } = threeCells();
    const r = applyEdit(
      doc,
      { type: "insert", index: 1, cellType: "markdown", source: "m" },
      ctx,
    );
    expect(sources(r.doc)).toEqual(["a", "m", "b", "c"]);
    expect(r.doc.cells[1]).toMatchObject({ id: "id1", cellType: "markdown" });
    expect(r.focus).toBe(r.doc.cells[1].key);
  });

  it("gives new cells no id in notebooks older than 4.5", () => {
    const { doc, ctx } = threeCells(4);
    const r = applyEdit(
      doc,
      { type: "insert", index: 99, cellType: "code" },
      ctx,
    );
    expect(r.doc.cells[3]).toMatchObject({ id: null, source: "" });
  });

  it("deletes cells and focuses the next one", () => {
    const { doc, ctx } = threeCells();
    const r = applyEdit(doc, { type: "delete", keys: ["k1", "k2"] }, ctx);
    expect(sources(r.doc)).toEqual(["c"]);
    expect(r.focus).toBe("k3");
    const last = applyEdit(doc, { type: "delete", keys: ["k3"] }, ctx);
    expect(last.focus).toBe("k2");
    const all = applyEdit(
      doc,
      { type: "delete", keys: ["k1", "k2", "k3"] },
      ctx,
    );
    expect(all.doc.cells).toEqual([]);
    expect(all.focus).toBeNull();
  });

  it("moves a cell, clamping the target", () => {
    const { doc, ctx } = threeCells();
    expect(
      sources(
        applyEdit(doc, { type: "move", key: "k1", toIndex: 99 }, ctx).doc,
      ),
    ).toEqual(["b", "c", "a"]);
    expect(
      sources(applyEdit(doc, { type: "move", key: "k3", toIndex: 0 }, ctx).doc),
    ).toEqual(["c", "a", "b"]);
  });

  it("duplicates a cell with a new key and id, keeping outputs", () => {
    const { doc, ctx } = threeCells();
    const r = applyEdit(doc, { type: "duplicate", key: "k2" }, ctx);
    const copy = r.doc.cells[2];
    expect(sources(r.doc)).toEqual(["a", "b", "b", "c"]);
    expect(copy.key).not.toBe("k2");
    expect(copy.id).toBe("id1");
    expect(copy.outputs).toBe(doc.cells[1].outputs);
  });

  it("converts types following nbformat's schema", () => {
    const { doc, ctx } = threeCells();
    const md = applyEdit(
      doc,
      { type: "setType", key: "k1", cellType: "markdown" },
      ctx,
    ).doc;
    expect(md.cells[0]).toMatchObject({
      cellType: "markdown",
      outputs: [],
      executionCount: null,
      source: "a",
    });
    const withAtt = {
      ...md,
      cells: [
        { ...md.cells[0], attachments: { "x.png": { "image/png": "" } } },
        ...md.cells.slice(1),
      ],
    };
    const raw = applyEdit(
      withAtt,
      { type: "setType", key: "k1", cellType: "raw" },
      ctx,
    ).doc;
    expect(raw.cells[0].attachments).toHaveProperty("x.png");
    const code = applyEdit(
      raw,
      { type: "setType", key: "k1", cellType: "code" },
      ctx,
    ).doc;
    expect(code.cells[0].attachments).toBeNull();
  });

  it("splits at offsets: first piece keeps the id, last keeps the outputs", () => {
    const { doc, ctx } = threeCells();
    const cell = { ...doc.cells[0], source: "x = 1\n\ny = 2\nz" };
    const d = { ...doc, cells: [cell, ...doc.cells.slice(1)] };
    const r = applyEdit(
      d,
      { type: "split", key: "k1", offsets: [7, 13, 0, 999] },
      ctx,
    );
    expect(sources(r.doc).slice(0, 3)).toEqual(["x = 1", "y = 2", "z"]);
    expect(r.doc.cells[0]).toMatchObject({
      key: "k1",
      id: "c0",
      outputs: [],
      executionCount: null,
    });
    expect(r.doc.cells[2]).toMatchObject({
      outputs: cell.outputs,
      executionCount: 1,
    });
    expect(new Set(r.doc.cells.map((c) => c.id)).size).toBe(r.doc.cells.length);
    expect(r.focus).toBe(r.doc.cells[1].key);
    expect(
      applyEdit(d, { type: "split", key: "k1", offsets: [0] }, ctx).doc,
    ).toBe(d);
  });

  it("merges cells in document order into the first", () => {
    const { doc, ctx } = threeCells();
    const r = applyEdit(doc, { type: "merge", keys: ["k3", "k1"] }, ctx);
    expect(sources(r.doc)).toEqual(["a\n\nc", "b"]);
    expect(r.doc.cells[0]).toMatchObject({
      key: "k1",
      id: "c0",
      executionCount: null,
    });
    expect(
      r.doc.cells[0].outputs.map((o) => o.outputType === "stream" && o.text),
    ).toEqual(["a!", "c!"]);
  });

  it("clears outputs of the given cells or all", () => {
    const { doc, ctx } = threeCells();
    const one = applyEdit(doc, { type: "clearOutputs", keys: ["k2"] }, ctx).doc;
    expect(one.cells.map((c) => c.outputs.length)).toEqual([1, 0, 1]);
    const all = applyEdit(one, { type: "clearOutputs" }, ctx).doc;
    expect(
      all.cells.every(
        (c) => c.outputs.length === 0 && c.executionCount === null,
      ),
    ).toBe(true);
    expect(applyEdit(all, { type: "clearOutputs" }, ctx).doc).toBe(all);
  });

  it("returns the same document for edits that change nothing", () => {
    const { doc, ctx } = threeCells();
    for (const edit of [
      { type: "delete", keys: ["nope"] },
      { type: "move", key: "k1", toIndex: 0 },
      { type: "setSource", key: "k1", source: "a" },
      { type: "setType", key: "k1", cellType: "code" },
      { type: "merge", keys: ["k1"] },
      { type: "duplicate", key: "nope" },
    ] as const) {
      expect(applyEdit(doc, edit, ctx).doc).toBe(doc);
    }
  });

  it("keeps a moved cell's original text on save", () => {
    const text = `{\n "cells": [\n  {\n   "cell_type": "markdown",\n   "metadata": {},\n   "source": "one string"\n  },\n  {\n   "cell_type": "raw",\n   "metadata": {},\n   "source": []\n  }\n ],\n "metadata": {},\n "nbformat": 4,\n "nbformat_minor": 4\n}\n`;
    const r = parseNotebook(text);
    if (!r.ok) throw new Error(r.error.message);
    const ctx = context();
    const moved = applyEdit(
      r.doc,
      { type: "move", key: r.doc.cells[0].key, toIndex: 1 },
      ctx,
    ).doc;
    expect(serializeNotebook(moved)).toContain('"source": "one string"');
    // Changing only the type keeps the source's single-string form too.
    const typed = applyEdit(
      r.doc,
      { type: "setType", key: r.doc.cells[0].key, cellType: "raw" },
      ctx,
    ).doc;
    expect(serializeNotebook(typed)).toContain('"source": "one string"');
  });
});

describe("applyExecution", () => {
  it("appends outputs, merging consecutive chunks of one stream", () => {
    const { doc } = threeCells();
    let d = applyExecution(doc, { type: "setOutputs", key: "k1", outputs: [] });
    d = applyExecution(d, {
      type: "appendOutput",
      key: "k1",
      output: stream("a"),
    });
    d = applyExecution(d, {
      type: "appendOutput",
      key: "k1",
      output: stream("b"),
    });
    d = applyExecution(d, {
      type: "appendOutput",
      key: "k1",
      output: stream("!", "stderr"),
    });
    expect(d.cells[0].outputs).toMatchObject([
      { name: "stdout", text: "ab" },
      { name: "stderr", text: "!" },
    ]);
  });

  it("updates every output with a display id", () => {
    const { doc } = threeCells();
    const shown: NotebookOutput = {
      outputType: "display_data",
      data: { "text/plain": "0%" },
      metadata: {},
      displayId: "bar",
      extra: {},
    };
    let d = applyExecution(doc, {
      type: "setOutputs",
      key: "k1",
      outputs: [shown],
    });
    d = applyExecution(d, { type: "setOutputs", key: "k3", outputs: [shown] });
    d = applyExecution(d, {
      type: "updateDisplay",
      displayId: "bar",
      data: { "text/plain": "100%" },
      metadata: {},
    });
    expect(d.cells[0].outputs[0]).toMatchObject({
      data: { "text/plain": "100%" },
    });
    expect(d.cells[2].outputs[0]).toMatchObject({
      data: { "text/plain": "100%" },
    });
    expect(
      applyExecution(d, {
        type: "updateDisplay",
        displayId: "other",
        data: {},
        metadata: {},
      }),
    ).toBe(d);
  });

  it("ignores events for missing or non-code cells", () => {
    const { doc, ctx } = threeCells();
    const md = applyEdit(
      doc,
      { type: "setType", key: "k1", cellType: "markdown" },
      ctx,
    ).doc;
    expect(
      applyExecution(md, { type: "setExecutionCount", key: "k1", count: 3 }),
    ).toBe(md);
    expect(
      applyExecution(md, { type: "setExecutionCount", key: "zz", count: 3 }),
    ).toBe(md);
  });
});

describe("history", () => {
  it("undoes and redoes edits and tracks the saved state", () => {
    const { doc, ctx } = threeCells();
    let h = createHistory(doc);
    expect(isDirty(h)).toBe(false);
    h = commitEdit(
      h,
      applyEdit(h.present.doc, { type: "delete", keys: ["k2"] }, ctx),
    );
    expect(isDirty(h)).toBe(true);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present.doc).toBe(doc);
    expect(isDirty(h)).toBe(false);
    expect(h.present.focus).toBe("k3");
    h = redo(h);
    expect(sources(h.present.doc)).toEqual(["a", "c"]);
    expect(canRedo(h)).toBe(false);
    h = markSaved(h);
    expect(isDirty(h)).toBe(false);
  });

  it("merges typing in one cell into one step", () => {
    const { doc, ctx } = threeCells();
    let h = createHistory(doc);
    for (const source of ["a1", "a12", "a123"]) {
      h = commitEdit(
        h,
        applyEdit(h.present.doc, { type: "setSource", key: "k1", source }, ctx),
        "type:k1",
      );
    }
    h = commitEdit(
      h,
      applyEdit(
        h.present.doc,
        { type: "setSource", key: "k2", source: "b1" },
        ctx,
      ),
      "type:k2",
    );
    expect(h.past).toHaveLength(2);
    h = undo(h);
    expect(sources(h.present.doc)).toEqual(["a123", "b", "c"]);
    // After an undo, new typing starts a new step instead of rewriting history.
    h = commitEdit(
      h,
      applyEdit(
        h.present.doc,
        { type: "setSource", key: "k1", source: "a1234" },
        ctx,
      ),
      "type:k1",
    );
    expect(h.past).toHaveLength(2);
    expect(canRedo(h)).toBe(false);
  });

  it("ignores no-op commits", () => {
    const { doc, ctx } = threeCells();
    const h = createHistory(doc);
    expect(
      commitEdit(
        h,
        applyEdit(doc, { type: "move", key: "k1", toIndex: 0 }, ctx),
      ),
    ).toBe(h);
  });

  it("keeps kernel output when an earlier edit is undone", () => {
    const { doc, ctx } = threeCells();
    let h = createHistory(doc);
    h = commitEdit(
      h,
      applyEdit(
        h.present.doc,
        { type: "setSource", key: "k2", source: "b2" },
        ctx,
      ),
    );
    h = applyExecutionToHistory(h, {
      type: "setOutputs",
      key: "k1",
      outputs: [stream("new")],
    });
    h = undo(h);
    expect(h.present.doc.cells[0].outputs).toMatchObject([{ text: "new" }]);
    expect(sources(h.present.doc)).toEqual(["a", "b", "c"]);
    expect(isDirty(h)).toBe(true);
  });
});
