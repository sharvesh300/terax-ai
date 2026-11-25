import { cn } from "@/lib/utils";
import { memo, type ReactNode, useMemo, useState } from "react";
import { cellView, mergeStreams } from "../lib/display";
import type { NotebookCell } from "../model";
import { MarkdownCell } from "./MarkdownCell";
import { NotebookOutputView } from "./NotebookOutputView";
import { SourceBlock } from "./SourceBlock";

const prompt = (n: number | null) => `[${n ?? " "}]:`;

/** One cell as shown in the notebook. Memoized: edits re-render only changed cells. */
export const NotebookCellView = memo(function NotebookCellView({
  cell,
  language,
  editor = null,
  onSourceClick,
}: {
  cell: NotebookCell;
  /** The notebook's code language, for highlighting code cells. */
  language: string | null;
  /** The live editor, shown in place of the source while editing. */
  editor?: ReactNode;
  /** Clicking a code or raw cell's source starts editing it. */
  onSourceClick?: () => void;
}) {
  if (cell.cellType === "markdown") {
    return (
      <Row cell>
        {editor ??
          (cell.source.trim() === "" ? (
            <p className="text-[12px] text-muted-foreground italic">
              Empty markdown cell — double-click to edit
            </p>
          ) : (
            <MarkdownCell source={cell.source} attachments={cell.attachments} />
          ))}
      </Row>
    );
  }

  if (cell.cellType === "raw") {
    return (
      <Row cell gutter={<span>raw</span>}>
        {editor ?? (
          <Clickable onClick={onSourceClick}>
            <SourceBlock source={cell.source} muted />
          </Clickable>
        )}
      </Row>
    );
  }

  return (
    <CodeCell
      cell={cell}
      language={language}
      editor={editor}
      onSourceClick={onSourceClick}
    />
  );
});

/** Source that starts editing on click, without nesting a button in a pre. */
function Clickable({
  onClick,
  children,
}: {
  onClick?: () => void;
  children: ReactNode;
}) {
  if (!onClick) return <>{children}</>;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Enter on the selected cell edits it (command mode).
    <div onClick={onClick} className="cursor-text">
      {children}
    </div>
  );
}

function CodeCell({
  cell,
  language,
  editor,
  onSourceClick,
}: {
  cell: NotebookCell;
  language: string | null;
  editor: ReactNode;
  onSourceClick?: () => void;
}) {
  const view = useMemo(() => cellView(cell.metadata), [cell.metadata]);
  const outputs = useMemo(() => mergeStreams(cell.outputs), [cell.outputs]);
  // Hidden parts open for this view only; the file keeps its flags.
  const [showSource, setShowSource] = useState(false);
  const [showOutputs, setShowOutputs] = useState(false);
  const sourceHidden = view.sourceHidden && !showSource;
  const outputsHidden = view.outputsHidden && !showOutputs;

  return (
    <div className="terax-notebook-cell flex flex-col gap-1.5">
      <Row gutter={prompt(cell.executionCount)}>
        {editor ??
          (sourceHidden ? (
            <Reveal onClick={() => setShowSource(true)}>
              Show hidden code
            </Reveal>
          ) : (
            <Clickable onClick={onSourceClick}>
              <SourceBlock source={cell.source} language={language} />
            </Clickable>
          ))}
      </Row>
      {outputs.length > 0 && outputsHidden && (
        <Row>
          <Reveal onClick={() => setShowOutputs(true)}>
            Show {outputs.length} hidden{" "}
            {outputs.length === 1 ? "output" : "outputs"}
          </Reveal>
        </Row>
      )}
      {outputs.length > 0 && !outputsHidden && (
        <div
          className={cn(
            "flex flex-col gap-1.5",
            view.scrolled && "max-h-[28rem] overflow-y-auto",
          )}
        >
          {outputs.map((output, i) => (
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
      )}
    </div>
  );
}

function Reveal({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-md border border-dashed border-border/70 px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  );
}

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
