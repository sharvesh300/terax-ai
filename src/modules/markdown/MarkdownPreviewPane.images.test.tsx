import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

const grant = vi.hoisted(() => ({ prefix: "" as string | null }));

vi.mock("./useMarkdownDocument", () => ({
  useMarkdownDocument: () => ({ kind: "ready", content: "![x](a.png)" }),
}));
vi.mock("@/lib/useAssetGrant", () => ({
  useAssetGrant: () => ({
    urlFor: (abs: string) =>
      grant.prefix === null ? undefined : `${grant.prefix}${abs}`,
    error: undefined,
    retry: () => {},
  }),
}));

function render(path: string) {
  return renderToString(
    createElement(MarkdownPreviewPane, {
      path,
      workspaceRoot: "/r",
      visible: true,
      onSetView: () => {},
    }),
  );
}

describe("MarkdownPreviewPane local images", () => {
  it("resolves each document's images against its own folder and grant", () => {
    grant.prefix = "asset://first";
    expect(render("/r/one/README.md")).toContain(
      'src="asset://first/r/one/a.png"',
    );
    // Same markdown text, another document: Streamdown must not reuse the
    // first document's processor (it caches by plugin name).
    grant.prefix = "asset://second";
    expect(render("/r/two/README.md")).toContain(
      'src="asset://second/r/two/a.png"',
    );
  });

  it("picks up a grant that arrives after the first render", () => {
    grant.prefix = null;
    expect(render("/r/three/README.md")).not.toContain("asset://");
    grant.prefix = "asset://late";
    expect(render("/r/three/README.md")).toContain(
      'src="asset://late/r/three/a.png"',
    );
  });
});
