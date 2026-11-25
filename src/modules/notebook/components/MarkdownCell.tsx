import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { rehypeLocalImages } from "@/modules/markdown/lib/assetPath";
import { MarkdownLink } from "@/modules/markdown/MarkdownLink";
import { createContext, memo, useContext, useMemo } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { mayHaveMath, rehypeAttachments } from "../lib/attachments";
import { nameForCache } from "@/lib/streamdownPluginName";
import type { JsonObject } from "../model";
import { useMath } from "./useMath";

/** How markdown cells may load images from disk; one grant per notebook. */
export type LocalImages = {
  /** The notebook's path; relative images resolve against its folder. */
  readonly path: string;
  readonly boundary: string;
  readonly urlFor: (absolutePath: string) => string | undefined;
  readonly isReadable: (absolutePath: string) => boolean;
};

export const LocalImagesContext = createContext<LocalImages | null>(null);

const components = { a: MarkdownLink, code: MarkdownCode };
const d = defaultRehypePlugins;

/**
 * A markdown cell through the markdown preview's sanitizing pipeline, plus
 * the cell's own attachments, images next to the notebook and KaTeX math.
 * Streamdown adds the math step after harden, so KaTeX's markup is kept.
 */
export const MarkdownCell = memo(function MarkdownCell({
  source,
  attachments,
}: {
  source: string;
  attachments: JsonObject | null;
}) {
  const images = useContext(LocalImagesContext);
  const math = useMath(mayHaveMath(source));
  const plugins = useMemo(() => (math ? { math } : undefined), [math]);
  const rehypePlugins = useMemo(() => {
    const att = rehypeAttachments(attachments);
    const local = images
      ? [
          nameForCache(
            rehypeLocalImages(
              images.path,
              (abs) => images.urlFor(abs) ?? "data:,",
              { boundary: images.boundary, isReadable: images.isReadable },
            ),
            "teraxLocalImages",
            images,
          ),
        ]
      : [];
    // Attachments are parked before sanitize, which drops their scheme, and
    // resolved after it; local images go after sanitize and before harden.
    return [d.raw, att.before, d.sanitize, att.after, ...local, d.harden];
  }, [attachments, images]);

  return (
    <Streamdown
      className="select-text text-[13.5px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
      components={components}
      rehypePlugins={rehypePlugins}
      plugins={plugins}
      mode="static"
      parseIncompleteMarkdown={false}
    >
      {source}
    </Streamdown>
  );
});
