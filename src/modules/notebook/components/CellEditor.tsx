import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { resolveLanguage } from "@/modules/editor/lib/languageResolver";
import { useEditorThemeExt } from "@/modules/editor/lib/useEditorThemeExt";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

export type CellEditorHandle = {
  undo: () => void;
  redo: () => void;
  focus: () => void;
  /** Appends text at the end (keys typed while the editor loaded). */
  insert: (text: string) => void;
};

type Props = {
  value: string;
  /** For the language registry (e.g. "cell.py"); null is plain text. */
  fileName: string | null;
  onChange: (value: string) => void;
  /** Escape: back to command mode. */
  onExit: () => void;
  /** Shift+Enter (run, next cell), Mod+Enter (run), Alt+Enter (run, insert). */
  onRun: (after: "advance" | "stay" | "insert") => void;
  /** Ctrl+Shift+Minus: split at the cursor (or the selection's ends). */
  onSplit: (offsets: number[]) => void;
  ref?: React.Ref<CellEditorHandle>;
};

// Matches SourceBlock, so entering edit mode does not move the text.
const cellTheme = EditorView.theme({
  "&, &.cm-editor, &.cm-editor.cm-focused": {
    backgroundColor: "transparent !important",
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    overflowX: "auto",
  },
  ".cm-content": { padding: "0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
    {
      backgroundColor:
        "color-mix(in srgb, var(--foreground) 18%, transparent) !important",
    },
  ".cm-gutters": { display: "none" },
});

/** The live editor for the cell being edited; only one exists at a time. */
export default function CellEditor({
  value,
  fileName,
  onChange,
  onExit,
  onRun,
  onSplit,
  ref,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const pendingInsert = useRef("");
  const languageRef = useRef(new Compartment());
  const themeRef = useRef(new Compartment());
  const callbacks = useRef({ onChange, onExit, onRun, onSplit });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onExit, onRun, onSplit };
  });
  const themeExt = useEditorThemeExt();
  const initialTheme = useRef(themeExt);

  useImperativeHandle(
    ref,
    () => ({
      undo: () => {
        const v = viewRef.current;
        if (v) undo(v);
      },
      redo: () => {
        const v = viewRef.current;
        if (v) redo(v);
      },
      focus: () => viewRef.current?.focus(),
      insert: (text: string) => {
        const v = viewRef.current;
        // The handle exists before the view does (layout vs passive effect).
        if (!v) {
          pendingInsert.current += text;
          return;
        }
        const end = v.state.doc.length;
        v.dispatch({
          changes: { from: end, insert: text },
          selection: { anchor: end + text.length },
        });
      },
    }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once; later values sync below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Keys typed while the editor loaded start out in it, with the caret
    // after them (a selection set after focusing would be read back).
    const typed = pendingInsert.current;
    pendingInsert.current = "";
    const initial = value + typed;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: false }),
          keymap.of([
            {
              key: "Escape",
              run: () => {
                callbacks.current.onExit();
                return true;
              },
            },
            {
              key: "Shift-Enter",
              run: () => {
                callbacks.current.onRun("advance");
                return true;
              },
            },
            // Jupyter takes Ctrl+Enter everywhere, and Cmd+Enter on macOS.
            {
              key: "Mod-Enter",
              mac: "Cmd-Enter",
              run: () => {
                callbacks.current.onRun("stay");
                return true;
              },
            },
            {
              key: "Ctrl-Enter",
              run: () => {
                callbacks.current.onRun("stay");
                return true;
              },
            },
            {
              key: "Alt-Enter",
              run: () => {
                callbacks.current.onRun("insert");
                return true;
              },
            },
            {
              key: "Ctrl-Shift--",
              run: (v) => {
                const { main } = v.state.selection;
                callbacks.current.onSplit(
                  main.empty ? [main.head] : [main.from, main.to],
                );
                return true;
              },
            },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          languageRef.current.of([]),
          themeRef.current.of(initialTheme.current),
          cellTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged)
              callbacks.current.onChange(u.state.doc.toString());
          }),
        ],
        selection: { anchor: initial.length },
      }),
    });
    viewRef.current = view;
    view.focus();
    if (typed) callbacks.current.onChange(initial);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // An undo in the notebook history can change the text from outside. Only
  // a change of the prop counts: text the view holds that the notebook has
  // not caught up with yet (typed ahead, just inserted) must not be undone.
  const lastValue = useRef(value);
  useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeRef.current.reconfigure(themeExt),
    });
  }, [themeExt]);

  useEffect(() => {
    let alive = true;
    if (!fileName) return;
    resolveLanguage(fileName)
      .then((lang) => {
        if (alive && lang)
          viewRef.current?.dispatch({
            effects: languageRef.current.reconfigure(lang.ext),
          });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fileName]);

  return (
    <div
      ref={hostRef}
      className="rounded-md border border-ring/70 bg-card px-3 py-2 font-mono text-[12.5px] leading-[1.55]"
    />
  );
}
