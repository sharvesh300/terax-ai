import {
  type HighlightedNode,
  highlight,
  isHighlightable,
} from "@/components/ai-elements/chat-code-lezer";
import { cn } from "@/lib/utils";
import { memo, useEffect, useState } from "react";

type Props = {
  source: string;
  /** Highlighter language name; null or unknown shows plain text. */
  language?: string | null;
  muted?: boolean;
};

/**
 * A cell's source, highlighted with the same Lezer parsers and `tok-*` theme
 * as chat code blocks. Plain text shows until the grammar has loaded, so the
 * layout never shifts.
 */
export const SourceBlock = memo(function SourceBlock({
  source,
  language = null,
  muted,
}: Props) {
  const [result, setResult] = useState<{
    source: string;
    language: string;
    nodes: HighlightedNode[];
  } | null>(null);
  const canHighlight =
    language !== null && source !== "" && isHighlightable(language);

  useEffect(() => {
    if (!canHighlight || language === null) return;
    let cancelled = false;
    highlight(source, language)
      .then((nodes) => {
        if (!cancelled && nodes) setResult({ source, language, nodes });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [source, language, canHighlight]);

  // A result for older text is dropped rather than shown against new text.
  const nodes =
    canHighlight && result?.source === source && result.language === language
      ? result.nodes
      : null;

  return (
    <pre
      className={cn(
        "select-text overflow-x-auto rounded-md border border-border/60 bg-card px-3 py-2 font-mono text-[12.5px] leading-[1.55]",
        muted && "text-muted-foreground",
      )}
    >
      {source === "" ? (
        <span className="text-muted-foreground/60"> </span>
      ) : nodes ? (
        nodes.map((node, i) =>
          node.kind === "break" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional.
            <span key={i}>{"\n"}</span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional.
            <span key={i} className={node.cls || undefined}>
              {node.value}
            </span>
          ),
        )
      ) : (
        source
      )}
    </pre>
  );
});
