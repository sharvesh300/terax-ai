import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import { cn } from "@/lib/utils";
import { MarkdownLink } from "@/modules/markdown/MarkdownLink";
import { memo, type ReactNode } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import type { NotebookCell } from "../model";
import { NotebookOutputView } from "./NotebookOutputView";

const components = { a: MarkdownLink, code: MarkdownCode };
const d = defaultRehypePlugins;
// Same sanitizing pipeline as the markdown preview. Local images and
// attachments arrive with the cell renderers.
const rehypePlugins = [d.raw, d.sanitize, d.harden];

const prompt = (n: number | null) => `[${n ?? " "}]:`;

/** One cell, read-only. Memoized: a reload re-renders only changed cells. */
export const NotebookCellView = memo(function NotebookCellView({
  cell,
}: {
  cell: NotebookCell;
}) {
  if (cell.cellType === "markdown") {
    return (
      <Row cell>
        {cell.source.trim() === "" ? (
          <p className="text-[12px] text-muted-foreground italic">
            Empty markdown cell
          </p>
        ) : (
          <Streamdown
            className="select-text text-[13.5px] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            components={components}
            rehypePlugins={rehypePlugins}
            mode="static"
            parseIncompleteMarkdown={false}
          >
            {cell.source}
          </Streamdown>
        )}
      </Row>
    );
  }

  if (cell.cellType === "raw") {
    return (
      <Row cell gutter={<span>raw</span>}>
        <SourceBlock source={cell.source} muted />
      </Row>
    );
  }

  return (
    <div className="terax-notebook-cell flex flex-col gap-1.5">
      <Row gutter={prompt(cell.executionCount)}>
        <SourceBlock source={cell.source} />
      </Row>
      {cell.outputs.map((output, i) => (
        <Row
          // Outputs have no identity of their own; order is stable per cell.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          key={i}
          gutter={
            output.outputType === "execute_result" ? (
              <span className="text-destructive/70">
                {`Out${prompt(output.executionCount)}`}
              </span>
            ) : null
          }
        >
          <NotebookOutputView output={output} />
        </Row>
      ))}
    </div>
  );
});

/** Prompt gutter on the left, content on the right, as in Jupyter. */
function Row({
  cell,
  gutter,
  children,
}: {
  /** The row is a whole cell (not a part of a code cell). */
  cell?: boolean;
  gutter?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2",
        cell && "terax-notebook-cell",
      )}
    >
      <div className="select-none pt-1.5 pr-1 text-right font-mono text-[11px] text-muted-foreground/80 tabular-nums">
        {gutter}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SourceBlock({ source, muted }: { source: string; muted?: boolean }) {
  return (
    <pre
      className={cn(
        "select-text overflow-x-auto rounded-md border border-border/60 bg-card px-3 py-2 font-mono text-[12.5px] leading-[1.55]",
        muted && "text-muted-foreground",
        source === "" && "text-muted-foreground/60",
      )}
    >
      {source === "" ? " " : source}
    </pre>
  );
}
