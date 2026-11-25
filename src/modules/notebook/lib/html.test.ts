import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { describe, expect, it } from "vitest";
import { hasScripts, sanitizeOutputHtml } from "./html";

// Rendered the way HtmlOutput renders it.
const clean = (html: string) =>
  renderToStaticMarkup(
    toJsxRuntime(sanitizeOutputHtml(html), { Fragment, jsx, jsxs }),
  );

describe("sanitizeOutputHtml", () => {
  it("keeps a pandas table", () => {
    const html =
      '<div><style scoped>.dataframe tbody tr th { x: y }</style><table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>a</th></tr></thead><tbody><tr><th>0</th><td>1</td></tr></tbody></table></div>';
    const out = clean(html);
    expect(out).toContain("<table");
    expect(out).toContain("<td>1</td>");
    expect(out).not.toContain("<style");
    expect(out).not.toContain("style=");
  });

  it("removes scripts, handlers, frames, forms and javascript: links", () => {
    const out = clean(
      '<p onclick="x()">t</p><script>alert(1)</script><iframe src="https://e"></iframe><form action="/x"><input name="p"></form><a href="javascript:alert(1)">l</a><svg><script>1</script></svg>',
    );
    for (const bad of [
      "onclick",
      "<script",
      "alert",
      "<iframe",
      "<form",
      "javascript:",
      "<svg",
    ]) {
      expect(out).not.toContain(bad);
    }
    expect(out).toContain("<p>t</p>");
  });

  it("keeps inline image data but nothing else in data URLs", () => {
    expect(clean('<img src="data:image/png;base64,iVBO">')).toContain(
      'src="data:image/png;base64,iVBO"',
    );
    expect(
      clean('<img src="data:text/html,<script>1</script>">'),
    ).not.toContain("src=");
    expect(clean('<a href="data:text/html,x">l</a>')).not.toContain("href=");
  });

  it("prefixes ids so outputs cannot clobber the app's", () => {
    expect(clean('<div id="root">x</div>')).toContain('id="user-content-root"');
  });
});

describe("hasScripts", () => {
  it("spots script tags in any case", () => {
    expect(hasScripts("<SCRIPT src=x>")).toBe(true);
    expect(hasScripts("<p>describe the script</p>")).toBe(false);
  });
});
