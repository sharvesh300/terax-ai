// `text/html` outputs (pandas tables, IPython.display.HTML) as static,
// sanitized markup. Scripts, styles, event handlers, forms and frames never
// survive; nothing in an output can run or reach the app.

import type { Element, Root, RootContent } from "hast";
import { raw } from "hast-util-raw";
import { defaultSchema, type Schema, sanitize } from "hast-util-sanitize";

/** Above this, parsing would stall the view; the text form is shown instead. */
export const MAX_HTML_CHARS = 2_000_000;

const SCRIPT = /<script\b/i;

/** Whether the HTML depends on scripts this view never runs. */
export function hasScripts(html: string): boolean {
  return SCRIPT.test(html);
}

// GitHub's schema, plus inline images: outputs embed plots as data URLs.
const schema: Schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

// Only raster/vector image data, never data:text/html and the like.
const DATA_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;[a-z-]+=[^;,]*)*(?:;base64)?,/i;

function dropUnsafeImages(node: Root | RootContent): void {
  if (node.type === "element") {
    const el = node as Element;
    const src = el.properties.src;
    if (el.tagName === "img" && typeof src === "string") {
      const v = src.trim();
      if (/^data:/i.test(v) && !DATA_IMAGE.test(v)) delete el.properties.src;
    }
  }
  if ("children" in node)
    for (const child of node.children) dropUnsafeImages(child);
}

/** Parses and sanitizes an HTML output into a hast tree that is safe to render. */
export function sanitizeOutputHtml(html: string): Root {
  // hast-util-raw is the parser streamdown already ships (rehype-raw), so
  // this adds no second copy of parse5.
  const parsed = raw({
    type: "root",
    children: [{ type: "raw", value: html }],
  } as Root);
  const tree = sanitize(parsed, schema) as Root;
  dropUnsafeImages(tree);
  return tree;
}
