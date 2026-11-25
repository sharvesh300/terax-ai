import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  initialSession,
  type SessionState,
  sessionReducer,
} from "./lib/session";
import { NotebookPane } from "./NotebookPane";

type Status =
  | { kind: "ready"; content: string }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

const doc = vi.hoisted(() => ({
  state: { kind: "loading" } as unknown,
  force: [] as boolean[],
}));

vi.mock("./useNotebookSession", () => ({
  useNotebookSession: (_path: string, _visible: boolean, force: boolean) => {
    doc.force.push(force);
    return {
      state: doc.state,
      dispatch: () => {},
      save: async () => true,
      reloadFromDisk: () => {},
    };
  },
}));

const fixture = readFileSync(
  new URL("./model/__fixtures__/jupyter-4.5.ipynb", import.meta.url),
  "utf8",
);

function toState(status: Status): SessionState {
  if (status.kind !== "ready") return status;
  return sessionReducer(initialSession, {
    type: "read",
    result: {
      kind: "text",
      content: status.content,
      size: status.content.length,
      mtime: 1,
    },
  });
}

function render(status: Status) {
  doc.state = toState(status);
  return renderToString(
    createElement(NotebookPane, {
      path: "/r/eda.ipynb",
      visible: true,
      onSetView: () => {},
    }),
  );
}

describe("NotebookPane", () => {
  it("shows the kernel, prompts, markdown, text and images", () => {
    const html = render({ kind: "ready", content: fixture });
    expect(html).toContain("Python 3 (ipykernel)");
    expect(html).toContain("6<!-- --> <!-- -->cells");
    // Editing toolbar; running waits for a kernel.
    expect(html).toContain("No kernel");
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*title="Running cells needs a kernel/,
    );
    expect(html).toContain('aria-label="Cell type"');
    expect(html).toMatch(/<h1[^>]*>Analysis — résumé 📈<\/h1>/);
    expect(html).toContain("[1]:");
    expect(html).toContain("Out[2]:");
    expect(html).toContain("hello\nworld");
    // ANSI colours become styled spans in the terminal palette.
    expect(html).toContain(
      'warn: <span style="color:var(--terminal-ansi-red)">red</span>',
    );
    expect(html).not.toContain("\x1b");
    expect(html).toContain('src="data:image/png;base64,iVBOR');
    // The DataFrame's HTML is shown sanitized, not its text form.
    expect(html).toContain("<td>1</td>");
    expect(html).not.toContain("   a\n0  1");
    expect(html).toContain("ZeroDivisionError");
    expect(html).toContain("An output type this version does not know");
  });

  it("shows a markdown cell's attachment image", () => {
    const html = render({ kind: "ready", content: fixture });
    expect(html).toMatch(
      /<img[^>]*alt="img"[^>]*src="data:image\/png;base64,iVBOR/,
    );
  });

  it("renders JSON, LaTeX, markdown and scripted outputs, and hidden parts", () => {
    const out = (data: Record<string, unknown>) => ({
      output_type: "display_data",
      data,
      metadata: {},
    });
    const nb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: "code",
          id: "a",
          metadata: {},
          execution_count: 1,
          source: "x",
          outputs: [
            out({ "application/json": { answer: 42, tags: ["a"] } }),
            out({ "text/markdown": "**bold** result" }),
            out({
              "text/html": "<div id=p></div><script>Plotly.newPlot()</script>",
              "text/plain": "Figure()",
            }),
          ],
        },
        {
          cell_type: "code",
          id: "b",
          metadata: { jupyter: { source_hidden: true, outputs_hidden: true } },
          execution_count: 2,
          source: "secret_source()",
          outputs: [out({ "text/plain": "secret output" })],
        },
      ],
    };
    // Without React's text-separator comments.
    const html = render({ kind: "ready", content: JSON.stringify(nb) }).replace(
      /<!-- -->/g,
      "",
    );
    expect(html).toContain("answer");
    expect(html).toContain('<span class="tok-number">42</span>');
    expect(html).toMatch(/<(strong|span)[^>]*>bold<\/(strong|span)>/);
    expect(html).toContain("Figure()");
    expect(html).not.toContain("Plotly");
    expect(html).toContain("Show hidden code");
    expect(html).toContain("Show 1 hidden output");
    expect(html).not.toContain("secret_source");
    expect(html).not.toContain("secret output");
  });

  it("guards unsaved edits: Raw is off, Save is on, disk changes ask", () => {
    let state = toState({ kind: "ready", content: fixture });
    if (state.kind !== "ready") throw new Error("not ready");
    const key = state.history.present.doc.cells[0].key;
    state = sessionReducer(state, {
      type: "edit",
      edit: { type: "setSource", key, source: "# Changed" },
    });
    doc.state = state;
    const dirty = renderToString(
      createElement(NotebookPane, {
        path: "/r/eda.ipynb",
        visible: true,
        onSetView: () => {},
      }),
    );
    expect(dirty).toMatch(
      /<button[^>]*disabled=""[^>]*title="Save to view the raw file"[^>]*>Raw/,
    );
    expect(dirty).toMatch(/<button[^>]*title="Save"/);
    expect(dirty).not.toContain("changed on disk");

    doc.state = sessionReducer(state, {
      type: "read",
      result: {
        kind: "text",
        content: fixture.replace("Analysis", "Other"),
        size: 1,
        mtime: 9,
      },
    });
    const conflict = renderToString(
      createElement(NotebookPane, {
        path: "/r/eda.ipynb",
        visible: true,
        onSetView: () => {},
      }),
    );
    expect(conflict).toContain("changed on disk while you had unsaved changes");
    expect(conflict).toContain("Reload from disk");
    expect(conflict).toContain("Keep my version");
  });

  it("explains a file it cannot parse and offers the raw view", () => {
    const html = render({
      kind: "ready",
      content: '{"nbformat": 3, "nbformat_minor": 0}',
    });
    expect(html).toContain("This notebook cannot be shown");
    expect(html).toContain("only version 4 is");
    expect(html).toContain("Open as text");
  });

  it("offers Open anyway only below the hard read limit", () => {
    const big = render({
      kind: "toolarge",
      size: 20 * 1024 * 1024,
      limit: 10 * 1024 * 1024,
    });
    expect(big).toContain("Open anyway");
    expect(doc.force[doc.force.length - 1]).toBe(false);
    const huge = render({
      kind: "toolarge",
      size: 80 * 1024 * 1024,
      limit: 10 * 1024 * 1024,
    });
    expect(huge).not.toContain("Open anyway");
    expect(huge).toContain("50.0 MB maximum");
  });

  it("shows empty notebooks and read errors plainly", () => {
    expect(
      render({
        kind: "ready",
        content:
          '{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": []}',
      }),
    ).toContain("This notebook has no cells.");
    expect(render({ kind: "error", message: "denied" })).toContain(
      "Failed to read file: <!-- -->denied",
    );
  });
});
