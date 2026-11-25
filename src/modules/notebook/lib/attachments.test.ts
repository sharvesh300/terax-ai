import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";
import { notebookMath } from "../components/mathRuntime";
import {
  attachmentUrl,
  mayHaveImages,
  mayHaveMath,
  rehypeAttachments,
} from "./attachments";

const PNG = "iVBORw0KGgo=";
const attachments = {
  "dot.png": { "image/png": PNG },
  "my plot.png": { "image/png": [PNG.slice(0, 4), PNG.slice(4)] },
  "logo.svg": { "image/svg+xml": "<svg/>" },
  "notes.txt": { "text/plain": "hi" },
  "bad.png": { "image/png": 'x" onerror="y' },
};

const d = defaultRehypePlugins;

function render(
  markdown: string,
  atts: typeof attachments | null = attachments,
) {
  const att = rehypeAttachments(atts);
  return renderToString(
    createElement(
      Streamdown,
      {
        mode: "static",
        parseIncompleteMarkdown: false,
        rehypePlugins: [d.raw, att.before, d.sanitize, att.after, d.harden],
      },
      markdown,
    ),
  );
}

describe("attachmentUrl", () => {
  it("returns a data URL for image attachments only", () => {
    expect(attachmentUrl(attachments, "dot.png")).toBe(
      `data:image/png;base64,${PNG}`,
    );
    expect(attachmentUrl(attachments, "my plot.png")).toBe(
      `data:image/png;base64,${PNG}`,
    );
    expect(attachmentUrl(attachments, "logo.svg")).toMatch(
      /^data:image\/svg\+xml;charset=utf-8,/,
    );
    expect(attachmentUrl(attachments, "notes.txt")).toBeNull();
    expect(attachmentUrl(attachments, "bad.png")).toBeNull();
    expect(attachmentUrl(attachments, "missing.png")).toBeNull();
    expect(attachmentUrl(attachments, "toString")).toBeNull();
    expect(attachmentUrl(null, "dot.png")).toBeNull();
  });
});

describe("rehypeAttachments", () => {
  it("shows markdown and HTML attachment images through the sanitizer", () => {
    expect(render("![dot](attachment:dot.png)")).toContain(
      `src="data:image/png;base64,${PNG}"`,
    );
    expect(render('<img src="attachment:dot.png">')).toContain(
      `src="data:image/png;base64,${PNG}"`,
    );
    expect(render("![p](attachment:my%20plot.png)")).toContain(
      `src="data:image/png;base64,${PNG}"`,
    );
  });

  it("drops references the cell cannot resolve", () => {
    for (const md of [
      "![x](attachment:missing.png)",
      "![x](attachment:notes.txt)",
      "![x](attachment:bad.png)",
    ]) {
      const html = render(md);
      expect(html).not.toContain("src=");
      expect(html).not.toContain("onerror");
    }
    expect(render("![x](attachment:dot.png)", null)).not.toContain("src=");
  });

  it("gives each cell its own attachments despite Streamdown's cache", () => {
    const other = { "dot.png": { "image/png": "R0lGODlh" } };
    expect(render("![d](attachment:dot.png)")).toContain(PNG);
    const second = render("![d](attachment:dot.png)", other as never);
    expect(second).toContain("R0lGODlh");
    expect(second).not.toContain(PNG);
  });

  it("leaves other images to the rest of the pipeline", () => {
    expect(render("![r](https://example.com/a.png)")).toContain(
      'src="https://example.com/a.png"',
    );
  });
});

describe("cheap pre-checks", () => {
  it("spots possible images and math", () => {
    expect(mayHaveImages("see ![x](a.png)")).toBe(true);
    expect(mayHaveImages('<IMG src="a.png">')).toBe(true);
    expect(mayHaveImages("just text [link](a)")).toBe(false);
    expect(mayHaveMath("energy $E=mc^2$")).toBe(true);
    expect(mayHaveMath("no math")).toBe(false);
  });
});

describe("notebook math", () => {
  it("renders inline and display math with KaTeX", () => {
    const html = renderToString(
      createElement(
        Streamdown,
        {
          mode: "static",
          parseIncompleteMarkdown: false,
          plugins: { math: notebookMath },
        },
        "Inline $x^2$ and\n\n$$\n\\frac{a}{b}\n$$",
      ),
    );
    expect(html).toContain('class="katex"');
    expect(html).toContain("katex-display");
  });
});
