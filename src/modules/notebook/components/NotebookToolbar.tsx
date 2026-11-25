import { cn } from "@/lib/utils";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Copy01Icon,
  Delete02Icon,
  EraserIcon,
  FloppyDiskIcon,
  NextIcon,
  PlayIcon,
  RefreshIcon,
  StopIcon,
  Redo02Icon,
  Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { KernelPhase, KernelView } from "../kernel/useKernel";
import type { CellType } from "../model";

type IconData = Parameters<typeof HugeiconsIcon>[0]["icon"];

function ToolButton({
  icon,
  label,
  onClick,
  disabled,
  children,
}: {
  icon?: IconData;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={children ? undefined : label}
      // Keep the cell editor's focus until the click lands.
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
    >
      {icon && <HugeiconsIcon icon={icon} size={13} strokeWidth={1.8} />}
      {children}
    </button>
  );
}

const Divider = () => (
  <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
);

export function NotebookToolbar({
  dirty,
  canUndo,
  canRedo,
  selectedType,
  onSave,
  onUndo,
  onRedo,
  onAdd,
  onSetType,
  onClearOutputs,
  kernel,
  onRun,
  onRunAll,
  onInterrupt,
  onRestart,
  onPickKernel,
}: {
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectedType: CellType | null;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAdd: (cellType: CellType) => void;
  onSetType: (cellType: CellType) => void;
  onClearOutputs: () => void;
  kernel: KernelView;
  onRun: () => void;
  onRunAll: () => void;
  onInterrupt: () => void;
  onRestart: () => void;
  onPickKernel: () => void;
}) {
  return (
    // Right padding keeps the buttons clear of the Rendered/Raw toggle.
    <div className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border/60 px-3 pr-40">
      <ToolButton
        icon={FloppyDiskIcon}
        label={dirty ? "Save" : "Saved"}
        onClick={onSave}
        disabled={!dirty}
      />
      <Divider />
      <ToolButton
        icon={Add01Icon}
        label="Add code cell"
        onClick={() => onAdd("code")}
      >
        Code
      </ToolButton>
      <ToolButton
        icon={Add01Icon}
        label="Add markdown cell"
        onClick={() => onAdd("markdown")}
      >
        Markdown
      </ToolButton>
      <Divider />
      <select
        aria-label="Cell type"
        value={selectedType ?? ""}
        disabled={selectedType === null}
        onChange={(e) => onSetType(e.target.value as CellType)}
        className="h-6 rounded border border-border/60 bg-card px-1 text-[11px] text-foreground disabled:opacity-40"
      >
        <option value="code">Code</option>
        <option value="markdown">Markdown</option>
        <option value="raw">Raw</option>
      </select>
      <ToolButton
        icon={EraserIcon}
        label="Clear all outputs"
        onClick={onClearOutputs}
      />
      <Divider />
      <ToolButton
        icon={Undo02Icon}
        label="Undo"
        onClick={onUndo}
        disabled={!canUndo}
      />
      <ToolButton
        icon={Redo02Icon}
        label="Redo"
        onClick={onRedo}
        disabled={!canRedo}
      />
      <Divider />
      <ToolButton
        icon={PlayIcon}
        label="Run cell (Shift+Enter)"
        onClick={onRun}
      >
        Run
      </ToolButton>
      <ToolButton icon={NextIcon} label="Run all cells" onClick={onRunAll} />
      <ToolButton
        icon={StopIcon}
        label="Interrupt the kernel (I, I)"
        onClick={onInterrupt}
        disabled={!kernel.busy}
      />
      <ToolButton
        icon={RefreshIcon}
        label="Restart the kernel (0, 0)"
        onClick={onRestart}
        disabled={kernel.phase === "none" || kernel.phase === "connecting"}
      />
      <KernelButton kernel={kernel} onClick={onPickKernel} />
      {dirty && (
        <span className="ml-2 inline-flex items-center">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-foreground/70"
          />
          <span className="sr-only">Unsaved changes</span>
        </span>
      )}
    </div>
  );
}

/** Move, duplicate and delete for the selected cell. */
export function CellActions({
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDuplicate,
  onDelete,
}: {
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="absolute -top-3 right-1 z-10 flex items-center rounded-md border border-border/60 bg-popover shadow-sm">
      <ToolButton
        icon={ArrowUp01Icon}
        label="Move up"
        onClick={onMoveUp}
        disabled={!canMoveUp}
      />
      <ToolButton
        icon={ArrowDown01Icon}
        label="Move down"
        onClick={onMoveDown}
        disabled={!canMoveDown}
      />
      <ToolButton icon={Copy01Icon} label="Duplicate" onClick={onDuplicate} />
      <ToolButton icon={Delete02Icon} label="Delete" onClick={onDelete} />
    </div>
  );
}

/**
 * "+ Code / + Markdown" between cells; shown on hover unless `always`. While
 * a cell is dragged over this gap, it is the drop line instead.
 */
export function InsertBar({
  always,
  onInsert,
  dropIndicator,
}: {
  always?: boolean;
  onInsert: (cellType: CellType) => void;
  dropIndicator?: boolean;
}) {
  return (
    <div
      className={cn(
        "group/insert relative flex h-5 items-center justify-center gap-1",
        always && "h-7",
      )}
    >
      {dropIndicator ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-ring"
        />
      ) : (
        <div
          className={cn(
            "flex gap-1 transition-opacity focus-within:opacity-100",
            always ? "opacity-100" : "opacity-0 group-hover/insert:opacity-100",
          )}
        >
          <InsertButton onClick={() => onInsert("code")}>Code</InsertButton>
          <InsertButton onClick={() => onInsert("markdown")}>
            Markdown
          </InsertButton>
        </div>
      )}
    </div>
  );
}

function InsertButton({
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
      onMouseDown={(e) => e.preventDefault()}
      className="inline-flex h-5 items-center gap-1 rounded border border-border/60 bg-card px-1.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <HugeiconsIcon icon={Add01Icon} size={11} strokeWidth={2} />
      {children}
    </button>
  );
}

const PHASE_LABEL: Record<KernelPhase, string> = {
  none: "No kernel",
  connecting: "Starting…",
  starting: "Starting…",
  idle: "Idle",
  busy: "Busy",
  restarting: "Restarting…",
  dead: "Stopped",
};

/** The kernel in use and its state; opens the kernel picker. */
function KernelButton({
  kernel,
  onClick,
}: {
  kernel: KernelView;
  onClick: () => void;
}) {
  const { phase, spec } = kernel;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      title={
        spec ? `${spec.displayName} — ${PHASE_LABEL[phase]}` : "Select a kernel"
      }
      className="ml-1 inline-flex h-6 max-w-56 items-center gap-1.5 rounded border border-border/60 px-1.5 text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          phase === "idle" && "bg-emerald-500",
          phase === "busy" && "bg-amber-500",
          (phase === "connecting" ||
            phase === "starting" ||
            phase === "restarting") &&
            "bg-sky-500",
          phase === "dead" && "bg-destructive",
          phase === "none" && "bg-muted-foreground/50",
        )}
      />
      <span className="truncate">
        {spec && phase !== "none" ? spec.displayName : "Select kernel"}
      </span>
      <span className="sr-only">{PHASE_LABEL[phase]}</span>
    </button>
  );
}
