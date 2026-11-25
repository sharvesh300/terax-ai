import { isHighlightable } from "@/components/ai-elements/chat-code-lezer";
import { describe, expect, it } from "vitest";
import {
  cellView,
  clipLines,
  errorText,
  imageSrc,
  kernelLabel,
  mergeStreams,
  notebookLanguage,
  pickDisplayMime,
  renderKeys,
} from "./display";

describe("pickDisplayMime", () => {
  it("ranks outputs as JupyterLab does, within what this view shows", () => {
    expect(
      pickDisplayMime({ "text/plain": "<Figure>", "image/png": "iVBO" }),
    ).toBe("image/png");
    expect(
      pickDisplayMime({ "text/html": "<table/>", "text/plain": "   a" }),
    ).toBe("text/html");
    expect(
      pickDisplayMime({
        "text/latex": "$x$",
        "image/png": "iVBO",
        "text/plain": "x",
      }),
    ).toBe("text/latex");
    expect(
      pickDisplayMime({ "application/json": { a: 1 }, "text/plain": "{}" }),
    ).toBe("application/json");
    expect(
      pickDisplayMime({ "application/vnd.plotly.v1+json": {} }),
    ).toBeNull();
    // A JSON value under a text type is malformed, not displayable.
    expect(pickDisplayMime({ "text/plain": { x: 1 } })).toBeNull();
  });

  it("passes over HTML that needs scripts unless nothing else exists", () => {
    const plotly = '<div id="p"></div><script>Plotly.newPlot("p")</script>';
    expect(pickDisplayMime({ "text/html": plotly, "image/png": "iVBO" })).toBe(
      "image/png",
    );
    expect(
      pickDisplayMime({ "text/html": plotly, "text/plain": "Figure" }),
    ).toBe("text/plain");
    expect(pickDisplayMime({ "text/html": plotly })).toBe("text/html");
  });

  it("falls back to text for HTML too large to parse", () => {
    const huge = `<p>${"x".repeat(2_000_001)}</p>`;
    expect(pickDisplayMime({ "text/html": huge, "text/plain": "x" })).toBe(
      "text/plain",
    );
  });
});

describe("errorText", () => {
  it("keeps the traceback's colours for the renderer", () => {
    expect(
      errorText({
        outputType: "error",
        ename: "E",
        evalue: "v",
        traceback: ["\x1b[31mline 1\x1b[0m", "E: v"],
        extra: {},
      }),
    ).toBe("\x1b[31mline 1\x1b[0m\nE: v");
    expect(
      errorText({
        outputType: "error",
        ename: "E",
        evalue: "v",
        traceback: [],
        extra: {},
      }),
    ).toBe("E: v");
  });
});

describe("mergeStreams", () => {
  it("joins consecutive chunks of the same stream only", () => {
    const s = (name: string, text: string) =>
      ({ outputType: "stream", name, text, extra: {} }) as const;
    const merged = mergeStreams([
      s("stdout", "a"),
      s("stdout", "b"),
      s("stderr", "!"),
      s("stdout", "c"),
    ]);
    expect(merged.map((o) => o.outputType === "stream" && o.text)).toEqual([
      "ab",
      "!",
      "c",
    ]);
  });
});

describe("cellView", () => {
  it("reads JupyterLab and classic Notebook view flags", () => {
    expect(cellView({})).toEqual({
      sourceHidden: false,
      outputsHidden: false,
      scrolled: false,
    });
    expect(
      cellView({
        jupyter: { source_hidden: true, outputs_hidden: true },
        scrolled: true,
      }),
    ).toEqual({ sourceHidden: true, outputsHidden: true, scrolled: true });
    expect(cellView({ collapsed: true }).outputsHidden).toBe(true);
    expect(cellView({ scrolled: "auto" }).scrolled).toBe(false);
  });
});

describe("imageSrc", () => {
  it("builds base64 data URLs, ignoring line breaks", () => {
    expect(imageSrc("image/png", "iVBO\nRw0K\n")).toBe(
      "data:image/png;base64,iVBORw0K",
    );
  });

  it("rejects data that is not base64, so nothing else lands in the URL", () => {
    expect(imageSrc("image/png", 'x" onerror="alert(1)')).toBeNull();
    expect(imageSrc("image/png", "")).toBeNull();
    expect(imageSrc("image/png", 5)).toBeNull();
    expect(imageSrc("image/bmp", "AAAA")).toBeNull();
  });

  it("encodes SVG for an <img>, where its scripts cannot run", () => {
    const src = imageSrc("image/svg+xml", '<svg onload="x()"></svg>');
    expect(src).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg onload="x()"></svg>')}`,
    );
  });
});

describe("clipLines", () => {
  it("keeps short text whole", () => {
    expect(clipLines("a\nb\n", 2)).toEqual({ text: "a\nb\n", hiddenLines: 0 });
    expect(clipLines("a\nb", 2)).toEqual({ text: "a\nb", hiddenLines: 0 });
  });

  it("clips long text and counts the hidden lines", () => {
    expect(clipLines("1\n2\n3\n4\n", 2)).toEqual({
      text: "1\n2",
      hiddenLines: 2,
    });
    expect(clipLines("1\n2\n3", 1)).toEqual({ text: "1", hiddenLines: 2 });
  });
});

describe("kernelLabel", () => {
  it("prefers the kernel's display name, then the language", () => {
    expect(
      kernelLabel({
        kernelspec: {
          display_name: "Python 3 (ipykernel)",
          language: "python",
        },
      }),
    ).toBe("Python 3 (ipykernel)");
    expect(kernelLabel({ kernelspec: { language: "R" } })).toBe("R");
    expect(kernelLabel({ language_info: { name: "julia" } })).toBe("julia");
    expect(kernelLabel({ kernelspec: [] as never })).toBeNull();
    expect(kernelLabel({})).toBeNull();
  });
});

describe("renderKeys", () => {
  it("uses unique cell ids and falls back to positions", () => {
    expect(
      renderKeys([{ id: "a" }, { id: null }, { id: "a" }, { id: "b" }]),
    ).toEqual(["id:a", "at:1", "at:2", "id:b"]);
  });
});

describe("notebookLanguage", () => {
  it("maps kernel languages to highlighter names", () => {
    expect(notebookLanguage({ language_info: { name: "python" } })).toBe(
      "python",
    );
    expect(notebookLanguage({ kernelspec: { language: "ipython3" } })).toBe(
      "python",
    );
    expect(notebookLanguage({ language_info: { name: "C++17" } })).toBe("cpp");
    expect(notebookLanguage({ language_info: { name: "R" } })).toBe("r");
    expect(notebookLanguage({})).toBeNull();
  });

  it("names languages the code highlighter knows", () => {
    for (const name of [
      "python",
      "R",
      "typescript",
      "javascript",
      "rust",
      "go",
      "scala",
      "C++17",
    ]) {
      const lang = notebookLanguage({ language_info: { name } });
      expect(isHighlightable(lang)).toBe(true);
    }
  });
});
