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
};

type Props = {
  value: string;
  /** For the language registry (e.g. "cell.py"); null is plain text. */
  fileName: string | null;
  onChange: (value: string) => void;
  /** Escape: back to command mode. */
  onExit: () => void;
  /** Shift+Enter: leave the cell and move on. */
  onAdvance: () => void;
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
  onAdvance,
  onSplit,
  ref,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const themeRef = useRef(new Compartment());
  const callbacks = useRef({ onChange, onExit, onAdvance, onSplit });
  useLayoutEffect(() => {
    callbacks.current = { onChange, onExit, onAdvance, onSplit };
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
    }),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once; later values sync below.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
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
                callbacks.current.onAdvance();
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
        selection: { anchor: value.length },
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // An undo in the notebook history can change the text from outside.
  useEffect(() => {
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
