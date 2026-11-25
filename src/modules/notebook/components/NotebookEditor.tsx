import { cn } from "@/lib/utils";
import { DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type KeyboardEvent,
  lazy,
  memo,
  type PointerEvent,
  type ReactNode,
  type Ref,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cellFileName,
  commandModeKey,
  type NotebookCommand,
  neighbourKey,
} from "../lib/commands";
import { edgeScrollSpeed, gapAtY, moveTarget } from "../lib/dragOrder";
import type { SessionEvent } from "../lib/session";
import {
  type CellType,
  canRedo,
  canUndo,
  type NotebookCell,
  type NotebookEdit,
  type NotebookHistory,
} from "../model";
import type { CellEditorHandle } from "./CellEditor";
import { CellActions, InsertBar, NotebookToolbar } from "./NotebookToolbar";
import { NotebookCellView } from "./NotebookCellView";
import { SourceBlock } from "./SourceBlock";

const CellEditor = lazy(() => import("./CellEditor"));

type DragHandlers = {
  onPointerDown: (e: PointerEvent<HTMLElement>, key: string) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
};

export type NotebookEditorHandle = {
  undo: () => void;
  redo: () => void;
};

type Props = {
  history: NotebookHistory;
  dispatch: (ev: SessionEvent) => void;
  language: string | null;
  dirty: boolean;
  onSave: () => void;
  /** Header line shown under the toolbar (kernel, counts). */
  summary: ReactNode;
  ref?: Ref<NotebookEditorHandle>;
};

// Typing that never leaves the editor would otherwise grow the history
// unbounded; each visit to a cell's editor is one undo step.
const sourceGroup = (key: string, session: number) =>
  `source:${key}:${session}`;

const isTypingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest(
    "input, select, textarea, button, a, [contenteditable='true'], .cm-editor",
  ) !== null;

/**
 * The notebook as an editable document, with Jupyter's two modes. Command
 * mode (a cell is selected) takes single-key commands; edit mode is a live
 * CodeMirror editor in the selected cell, and only that one exists at a
 * time. Every change goes through the notebook history.
 */
export function NotebookEditor({
  history,
  dispatch,
  language,
  dirty,
  onSave,
  summary,
  ref,
}: Props) {
  const doc = history.present.doc;
  const keys = useMemo(() => doc.cells.map((c) => c.key), [doc.cells]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected =
    selectedKey !== null && keys.includes(selectedKey)
      ? selectedKey
      : (keys[0] ?? null);
  const [editing, setEditing] = useState(false);
  const editSession = useRef(0);
  const pendingDelete = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const cellEditorRef = useRef<CellEditorHandle>(null);

  const latest = useRef({ keys, selected, editing, cells: doc.cells });
  useLayoutEffect(() => {
    latest.current = { keys, selected, editing, cells: doc.cells };
  });

  // An edit or undo names the cell it touched; follow it.
  useEffect(() => {
    const focus = history.present.focus;
    if (focus !== null) setSelectedKey(focus);
  }, [history.present]);

  // Keep the selected cell in view as it moves (keyboard, insert, undo).
  useEffect(() => {
    if (selected === null) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-cell-key="${CSS.escape(selected)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const apply = useCallback(
    (edit: NotebookEdit, group: string | null = null) =>
      dispatch({ type: "edit", edit, group }),
    [dispatch],
  );

  const focusContainer = useCallback(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const startEditing = useCallback((key: string) => {
    editSession.current++;
    setSelectedKey(key);
    setEditing(true);
  }, []);

  const stopEditing = useCallback(() => {
    setEditing(false);
    focusContainer();
  }, [focusContainer]);

  const insertAt = useCallback(
    (index: number, cellType: CellType) => {
      apply({ type: "insert", index, cellType });
    },
    [apply],
  );

  const run = useCallback(
    (cmd: NotebookCommand) => {
      const { keys: ks, selected: sel } = latest.current;
      const index = sel === null ? -1 : ks.indexOf(sel);
      switch (cmd.type) {
        case "select":
          setSelectedKey(neighbourKey(ks, sel, cmd.delta));
          return;
        case "edit":
          if (sel !== null) startEditing(sel);
          return;
        case "insert":
          insertAt(
            cmd.where === "above" ? Math.max(index, 0) : index + 1,
            "code",
          );
          return;
        case "delete":
          if (sel !== null) apply({ type: "delete", keys: [sel] });
          return;
        case "setType":
          if (sel !== null)
            apply({ type: "setType", key: sel, cellType: cmd.cellType });
          return;
        case "mergeBelow": {
          const next = neighbourKey(ks, sel, 1);
          if (sel !== null && next !== null && next !== sel)
            apply({ type: "merge", keys: [sel, next] });
          return;
        }
        case "undo":
          dispatch({ type: "undo" });
          return;
        case "redo":
          dispatch({ type: "redo" });
          return;
        case "advance": {
          setEditing(false);
          focusContainer();
          // As in Jupyter, moving past the last cell adds a new one.
          if (index === ks.length - 1) insertAt(ks.length, "code");
          else setSelectedKey(neighbourKey(ks, sel, 1));
          return;
        }
      }
    },
    [apply, dispatch, focusContainer, insertAt, startEditing],
  );

  useImperativeHandle(
    ref,
    () => ({
      undo: () => {
        if (latest.current.editing) cellEditorRef.current?.undo();
        else dispatch({ type: "undo" });
      },
      redo: () => {
        if (latest.current.editing) cellEditorRef.current?.redo();
        else dispatch({ type: "redo" });
      },
    }),
    [dispatch],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || isTypingTarget(e.target)) return;
    const outcome = commandModeKey(e, pendingDelete.current);
    pendingDelete.current = outcome.pendingDelete;
    if (outcome.pendingDelete) {
      e.preventDefault();
      return;
    }
    if (outcome.command) {
      e.preventDefault();
      run(outcome.command);
    }
  };

  // Toolbar and cell actions act on the selected cell, then hand the keyboard
  // back to command mode, unless the action keeps the cell being edited
  // (moving it): then the editor gets its focus back.
  const act = useCallback(
    (
      edit: (key: string) => NotebookEdit | null,
      opts: { keepEditing?: boolean } = {},
    ) => {
      const sel = latest.current.selected;
      const keep = opts.keepEditing === true && latest.current.editing;
      if (latest.current.editing && !keep) setEditing(false);
      if (sel !== null) {
        const e = edit(sel);
        if (e) apply(e);
      }
      // Moving a node in the DOM drops its focus.
      if (keep) requestAnimationFrame(() => cellEditorRef.current?.focus());
      else focusContainer();
    },
    [apply, focusContainer],
  );

  const select = useCallback((key: string) => {
    if (latest.current.selected !== key) setEditing(false);
    setSelectedKey(key);
  }, []);
  const advance = useCallback(() => run({ type: "advance" }), [run]);
  const move = useCallback(
    (delta: -1 | 1) =>
      act(
        (key) => ({
          type: "move",
          key,
          toIndex: latest.current.keys.indexOf(key) + delta,
        }),
        { keepEditing: true },
      ),
    [act],
  );

  // Dragging cells by their handle. Pointer events with capture, as the tab
  // bar does: HTML5 drag and drop competes with the webview's file drop.
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ key: string; gap: number | null } | null>(
    null,
  );
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    y: number;
    key: string;
    active: boolean;
    handle: HTMLElement;
    raf: number | null;
  } | null>(null);

  const gapAt = useCallback((y: number) => {
    const els =
      containerRef.current?.querySelectorAll<HTMLElement>("[data-cell-key]");
    const spans = Array.from(els ?? [], (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    return gapAtY(spans, y);
  }, []);

  const updateGap = useCallback(() => {
    const st = dragRef.current;
    if (!st?.active) return;
    const gap = gapAt(st.y);
    setDrag((d) => (d && d.gap !== gap ? { ...d, gap } : d));
  }, [gapAt]);

  const endDrag = useCallback(() => {
    const st = dragRef.current;
    if (!st) return;
    if (st.raf !== null) cancelAnimationFrame(st.raf);
    if (st.handle.hasPointerCapture(st.pointerId))
      st.handle.releasePointerCapture(st.pointerId);
    document.body.style.userSelect = "";
    dragRef.current = null;
    setDrag(null);
  }, []);

  // Near the top or bottom edge the list scrolls, so a cell can travel
  // anywhere in a long notebook. Runs only while a drag is active.
  const autoScroll = useCallback(() => {
    const st = dragRef.current;
    const scroller = scrollerRef.current;
    if (!st?.active || !scroller) return;
    const r = scroller.getBoundingClientRect();
    const speed = edgeScrollSpeed(st.y, r.top, r.bottom);
    if (speed !== 0) {
      scroller.scrollTop += speed;
      updateGap();
    }
    st.raf = requestAnimationFrame(autoScroll);
  }, [updateGap]);

  const dragHandle = useMemo(
    () => ({
      onPointerDown: (e: PointerEvent<HTMLElement>, key: string) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {
          pointerId: e.pointerId,
          startY: e.clientY,
          y: e.clientY,
          key,
          active: false,
          handle: e.currentTarget,
          raf: null,
        };
        if (latest.current.selected !== key) setEditing(false);
        setSelectedKey(key);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        st.y = e.clientY;
        if (!st.active) {
          if (Math.abs(e.clientY - st.startY) < 4) return;
          st.active = true;
          document.body.style.userSelect = "none";
          setDrag({ key: st.key, gap: null });
          st.raf = requestAnimationFrame(autoScroll);
        }
        e.preventDefault();
        updateGap();
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        const st = dragRef.current;
        if (!st || st.pointerId !== e.pointerId) return;
        if (st.active) {
          const from = latest.current.keys.indexOf(st.key);
          const to = from === -1 ? null : moveTarget(from, gapAt(e.clientY));
          if (to !== null) apply({ type: "move", key: st.key, toIndex: to });
        }
        endDrag();
        if (!latest.current.editing) focusContainer();
      },
      onPointerCancel: () => endDrag(),
    }),
    [apply, autoScroll, endDrag, focusContainer, gapAt, updateGap],
  );

  // Escape drops a drag where it started.
  const dragActive = drag !== null;
  useEffect(() => {
    if (!dragActive) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      endDrag();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [dragActive, endDrag]);
  useEffect(() => endDrag, [endDrag]);

  const dragFrom = drag ? keys.indexOf(drag.key) : -1;
  const dropAt = (gap: number) =>
    drag?.gap === gap && dragFrom !== -1 && moveTarget(dragFrom, gap) !== null;

  const selectedCell = doc.cells.find((c) => c.key === selected) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <NotebookToolbar
        dirty={dirty}
        canUndo={canUndo(history)}
        canRedo={canRedo(history)}
        selectedType={selectedCell?.cellType ?? null}
        onSave={onSave}
        onUndo={() => {
          setEditing(false);
          dispatch({ type: "undo" });
          focusContainer();
        }}
        onRedo={() => {
          setEditing(false);
          dispatch({ type: "redo" });
          focusContainer();
        }}
        onAdd={(cellType) => {
          const { keys: ks, selected: sel } = latest.current;
          setEditing(false);
          insertAt(sel === null ? ks.length : ks.indexOf(sel) + 1, cellType);
          focusContainer();
        }}
        onSetType={(cellType) =>
          act((key) => ({ type: "setType", key, cellType }))
        }
        onClearOutputs={() => {
          setEditing(false);
          apply({ type: "clearOutputs" });
          focusContainer();
        }}
      />
      <div ref={scrollerRef} className="flex-1 overflow-auto">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the notebook's command-mode keyboard surface, like Jupyter's. */}
        <div
          ref={containerRef}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="mx-auto w-full max-w-5xl px-6 pt-4 pb-24 outline-none"
        >
          {summary}
          {doc.cells.length === 0 ? (
            <div className="mt-8 flex flex-col items-center gap-3 text-[12px] text-muted-foreground">
              <p>This notebook has no cells.</p>
              <InsertBar always onInsert={(t) => insertAt(0, t)} />
            </div>
          ) : (
            <div className="flex flex-col">
              <InsertBar
                onInsert={(t) => insertAt(0, t)}
                dropIndicator={dropAt(0)}
              />
              {doc.cells.map((cell, i) => (
                <div key={cell.key}>
                  <EditableCell
                    cell={cell}
                    selected={cell.key === selected}
                    editing={editing && cell.key === selected}
                    language={language}
                    editorRef={cellEditorRef}
                    group={sourceGroup(cell.key, editSession.current)}
                    isFirst={i === 0}
                    isLast={i === doc.cells.length - 1}
                    onSelect={select}
                    onEdit={startEditing}
                    onStopEditing={stopEditing}
                    onAdvance={advance}
                    onMove={move}
                    apply={apply}
                    act={act}
                    dragHandle={dragHandle}
                    dragging={drag?.key === cell.key && drag.gap !== null}
                  />
                  <InsertBar
                    always={i === doc.cells.length - 1}
                    onInsert={(t) => insertAt(i + 1, t)}
                    dropIndicator={dropAt(i + 1)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const EditableCell = memo(function EditableCell({
  cell,
  selected,
  editing,
  language,
  editorRef,
  group,
  isFirst,
  isLast,
  onSelect,
  onEdit,
  onStopEditing,
  onAdvance,
  onMove,
  apply,
  act,
  dragHandle,
  dragging,
}: {
  cell: NotebookCell;
  selected: boolean;
  editing: boolean;
  language: string | null;
  editorRef: Ref<CellEditorHandle>;
  group: string;
  isFirst: boolean;
  isLast: boolean;
  onSelect: (key: string) => void;
  onEdit: (key: string) => void;
  onStopEditing: () => void;
  onAdvance: () => void;
  onMove: (delta: -1 | 1) => void;
  apply: (edit: NotebookEdit, group?: string | null) => void;
  act: (
    edit: (key: string) => NotebookEdit | null,
    opts?: { keepEditing?: boolean },
  ) => void;
  dragHandle: DragHandlers;
  dragging: boolean;
}) {
  const key = cell.key;
  const fileName = cellFileName(cell.cellType, language);
  const editSource = useCallback(() => onEdit(key), [onEdit, key]);
  const editor = editing ? (
    <Suspense
      fallback={<SourceBlock source={cell.source} language={language} />}
    >
      <CellEditor
        ref={editorRef}
        value={cell.source}
        fileName={fileName}
        onChange={(source) => apply({ type: "setSource", key, source }, group)}
        onExit={onStopEditing}
        onAdvance={onAdvance}
        onSplit={(offsets) => {
          apply({ type: "split", key, offsets });
          onStopEditing();
        }}
      />
    </Suspense>
  ) : null;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: selection follows the pointer, as in Jupyter; the keyboard path is command mode.
    <div
      data-cell-key={key}
      onMouseDown={() => onSelect(key)}
      onDoubleClick={() => {
        if (cell.cellType !== "code" && !editing) onEdit(key);
      }}
      className={cn(
        "group/cell relative rounded-md border-l-2 py-1 pr-1 transition-colors",
        selected ? "border-l-ring" : "border-l-transparent",
        editing && "bg-accent/30",
        dragging && "opacity-40",
      )}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        onPointerDown={(e) => dragHandle.onPointerDown(e, key)}
        onPointerMove={dragHandle.onPointerMove}
        onPointerUp={dragHandle.onPointerUp}
        onPointerCancel={dragHandle.onPointerCancel}
        className={cn(
          "absolute top-1.5 left-1 z-10 flex h-6 w-4 cursor-grab touch-none items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground active:cursor-grabbing",
          selected
            ? "opacity-100"
            : "opacity-0 focus-visible:opacity-100 group-hover/cell:opacity-100",
        )}
      >
        <HugeiconsIcon icon={DragDropVerticalIcon} size={13} strokeWidth={2} />
      </button>
      {selected && (
        <CellActions
          canMoveUp={!isFirst}
          canMoveDown={!isLast}
          onMoveUp={() => onMove(-1)}
          onMoveDown={() => onMove(1)}
          onDuplicate={() => act((k) => ({ type: "duplicate", key: k }))}
          onDelete={() => act((k) => ({ type: "delete", keys: [k] }))}
        />
      )}
      <NotebookCellView
        cell={cell}
        language={language}
        editor={editor}
        onSourceClick={cell.cellType === "markdown" ? undefined : editSource}
      />
    </div>
  );
});
