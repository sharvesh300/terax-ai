import { isHighlightable } from "@/components/ai-elements/chat-code-lezer";
import { describe, expect, it } from "vitest";
import {
  applyCarriageReturns,
  clipLines,
  errorText,
  imageSrc,
  kernelLabel,
  notebookLanguage,
  pickDisplayMime,
  renderKeys,
  stripAnsi,
  terminalText,
} from "./display";

describe("pickDisplayMime", () => {
  it("prefers images over plain text and skips what it cannot show", () => {
    expect(
      pickDisplayMime({ "text/plain": "<Figure>", "image/png": "iVBO" }),
    ).toBe("image/png");
    expect(
      pickDisplayMime({ "text/html": "<table/>", "text/plain": "   a" }),
    ).toBe("text/plain");
    expect(
      pickDisplayMime({ "application/vnd.plotly.v1+json": {} }),
    ).toBeNull();
    // A JSON value under a text type is malformed, not displayable.
    expect(pickDisplayMime({ "text/plain": { x: 1 } })).toBeNull();
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

describe("terminal text", () => {
  it("strips colours, OSC titles and hyperlinks", () => {
    expect(stripAnsi("\x1b[0;31mError\x1b[0m: x")).toBe("Error: x");
    expect(stripAnsi("\x1b]0;title\x07ok")).toBe("ok");
    expect(stripAnsi("\x1b]8;;https://a\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  it("shows only the final state of carriage-return progress bars", () => {
    expect(applyCarriageReturns("10%\r50%\r100%\ndone")).toBe("100%\ndone");
    expect(applyCarriageReturns("abcdef\rXY")).toBe("XYcdef");
    expect(applyCarriageReturns("a\r\nb")).toBe("a\nb");
  });

  it("joins tracebacks and falls back to the exception name", () => {
    expect(
      errorText({
        outputType: "error",
        ename: "E",
        evalue: "v",
        traceback: ["\x1b[31mline 1\x1b[0m", "E: v"],
        extra: {},
      }),
    ).toBe("line 1\nE: v");
    expect(
      errorText({
        outputType: "error",
        ename: "E",
        evalue: "v",
        traceback: [],
        extra: {},
      }),
    ).toBe("E: v");
    expect(terminalText("\x1b[1m50%\r\x1b[1m99%")).toBe("99%");
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
