import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type LocalImages,
  LocalImagesContext,
  MarkdownCell,
} from "./MarkdownCell";

function render(source: string, images: LocalImages | null) {
  return renderToString(
    createElement(
      LocalImagesContext.Provider,
      { value: images },
      createElement(MarkdownCell, { source, attachments: null }),
    ),
  );
}

const images = (urlPrefix: string): LocalImages => ({
  path: "/repo/notebooks/eda.ipynb",
  boundary: "/repo",
  urlFor: (abs) => `${urlPrefix}${abs}`,
  isReadable: (abs) => !abs.includes("/.ssh/"),
});

describe("MarkdownCell local images", () => {
  it("loads images next to the notebook through the grant", () => {
    const html = render(
      "![p](figs/plot.png) ![u](../assets/u.svg)",
      images("asset://a"),
    );
    expect(html).toContain('src="asset://a/repo/notebooks/figs/plot.png"');
    expect(html).toContain('src="asset://a/repo/assets/u.svg"');
  });

  it("refuses paths outside the boundary, secret paths and non-images", () => {
    const html = render(
      "![a](../../etc/x.png) ![b](../.ssh/k.png) ![c](data.csv)",
      images("asset://a"),
    );
    expect(html).not.toContain("asset://a");
  });

  it("does not reuse another notebook's image settings", () => {
    render("![p](figs/plot.png)", images("asset://first"));
    const other = { ...images("asset://second"), path: "/repo/other/b.ipynb" };
    expect(render("![p](figs/plot.png)", other)).toContain(
      'src="asset://second/repo/other/figs/plot.png"',
    );
  });
});
