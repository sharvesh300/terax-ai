import { readFileSync } from "node:fs";
import type { MarkdownStatus } from "@/modules/markdown/useMarkdownDocument";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NotebookPane } from "./NotebookPane";

const doc = vi.hoisted(() => ({
  status: { kind: "loading" } as MarkdownStatus,
  force: [] as boolean[],
}));

vi.mock("@/modules/markdown/useMarkdownDocument", () => ({
  useMarkdownDocument: (_path: string, _visible: boolean, force: boolean) => {
    doc.force.push(force);
    return doc.status;
  },
}));

const fixture = readFileSync(
  new URL("./model/__fixtures__/jupyter-4.5.ipynb", import.meta.url),
  "utf8",
);

function render(status: MarkdownStatus) {
  doc.status = status;
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
    expect(html).toContain("Read-only");
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
