// Markdown cell attachments: `![](attachment:plot.png)` points into the cell's
// own `attachments` bundle, which Jupyter saves as base64 next to the source.

import { isJsonObject, type JsonObject } from "../model";
import { imageSrc } from "./display";
import { nameForCache } from "@/lib/streamdownPluginName";

const ATTACHMENT_SCHEME = /^attachment:/i;
// A fragment survives the sanitizer's URL check (it is relative) and can
// never load anything, so a reference that is not resolved stays inert.
const PLACEHOLDER = "#terax-attachment:";

// Same preference as image outputs; SVG goes through <img>, where it is inert.
const IMAGE_ORDER = ["image/png", "image/jpeg", "image/gif", "image/svg+xml"];

/** A data URL for the named attachment's image, if it has one. */
export function attachmentUrl(
  attachments: JsonObject | null,
  name: string,
): string | null {
  // Own members only: a name like "toString" must not reach the prototype.
  if (!attachments || !Object.getOwnPropertyDescriptor(attachments, name))
    return null;
  const bundle = attachments[name];
  if (!isJsonObject(bundle)) return null;
  for (const mime of IMAGE_ORDER) {
    const value = bundle[mime];
    if (value === undefined) continue;
    const src = imageSrc(mime, Array.isArray(value) ? value.join("") : value);
    if (src) return src;
  }
  return null;
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

type HastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function visitImages(node: HastNode, fn: (img: HastNode) => void): void {
  if (node.type === "element" && node.tagName === "img") fn(node);
  for (const child of node.children ?? []) visitImages(child, fn);
}

/**
 * A pair of rehype plugins around the sanitizer, which drops `attachment:`
 * URLs: `before` parks them as an inert fragment, `after` swaps in the data
 * URL. Placeholders the cell has no attachment for lose their `src`.
 */
export function rehypeAttachments(attachments: JsonObject | null) {
  const before = () => (tree: unknown) =>
    visitImages(tree as HastNode, (img) => {
      const src = img.properties?.src;
      if (typeof src === "string" && img.properties) {
        const trimmed = src.trim();
        if (ATTACHMENT_SCHEME.test(trimmed)) {
          img.properties.src =
            PLACEHOLDER + trimmed.replace(ATTACHMENT_SCHEME, "");
        }
      }
    });
  const after = () => (tree: unknown) =>
    visitImages(tree as HastNode, (img) => {
      const src = img.properties?.src;
      if (typeof src !== "string" || !img.properties) return;
      if (!src.startsWith(PLACEHOLDER)) return;
      const url = attachmentUrl(
        attachments,
        decodeName(src.slice(PLACEHOLDER.length)),
      );
      if (url) img.properties.src = url;
      else delete img.properties.src;
    });
  return {
    before,
    after: nameForCache(after, "teraxAttachments", attachments),
  };
}

const HAS_IMAGE = /!\[|<img\b/i;

/** Whether markdown might reference images, so a grant is worth asking for. */
export function mayHaveImages(source: string): boolean {
  return HAS_IMAGE.test(source);
}

/** Whether markdown might hold `$…$` or `$$…$$` math. */
export function mayHaveMath(source: string): boolean {
  return source.includes("$");
}
