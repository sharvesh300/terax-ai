import { cn } from "@/lib/utils";
import { memo, type ReactNode } from "react";
import type { NotebookCell } from "../model";
import { MarkdownCell } from "./MarkdownCell";
import { NotebookOutputView } from "./NotebookOutputView";
import { SourceBlock } from "./SourceBlock";

const prompt = (n: number | null) => `[${n ?? " "}]:`;

/** One cell, read-only. Memoized: a reload re-renders only changed cells. */
export const NotebookCellView = memo(function NotebookCellView({
  cell,
  language,
}: {
  cell: NotebookCell;
  /** The notebook's code language, for highlighting code cells. */
  language: string | null;
}) {
  if (cell.cellType === "markdown") {
    return (
      <Row cell>
        {cell.source.trim() === "" ? (
          <p className="text-[12px] text-muted-foreground italic">
            Empty markdown cell
          </p>
        ) : (
          <MarkdownCell source={cell.source} attachments={cell.attachments} />
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
        <SourceBlock source={cell.source} language={language} />
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
