// Jupyter's command-mode keys, as a pure table from a key press to a
// notebook command. Edit-mode keys live in the cell editor's keymap.

import type { CellType } from "../model";

export type NotebookCommand =
  | { readonly type: "select"; readonly delta: -1 | 1 }
  | { readonly type: "edit" }
  | { readonly type: "insert"; readonly where: "above" | "below" }
  | { readonly type: "delete" }
  | { readonly type: "setType"; readonly cellType: CellType }
  | { readonly type: "mergeBelow" }
  | { readonly type: "undo" }
  | { readonly type: "redo" }
  /**
   * Runs the selected cell (a markdown cell just renders), then: Shift+Enter
   * moves to the next cell, Ctrl/Cmd+Enter stays, Alt+Enter inserts below.
   */
  | { readonly type: "run"; readonly after: "advance" | "stay" | "insert" }
  | { readonly type: "interrupt" }
  | { readonly type: "restart" };

export type KeyPress = {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
};

/** First keys of Jupyter's double presses: D D, I I, 0 0. */
export type PendingKey = "d" | "i" | "0";

export type KeyOutcome = {
  readonly command: NotebookCommand | null;
  /** A first key was pressed; the next key decides. */
  readonly pending: PendingKey | null;
};

const NONE: KeyOutcome = { command: null, pending: null };
const run = (command: NotebookCommand): KeyOutcome => ({
  command,
  pending: null,
});

const DOUBLE: Record<PendingKey, NotebookCommand> = {
  d: { type: "delete" },
  i: { type: "interrupt" },
  "0": { type: "restart" },
};

/**
 * The command for a key press in command mode. Other chords with Cmd, Ctrl
 * or Alt are never notebook keys: they belong to the app's shortcuts.
 */
export function commandModeKey(
  e: KeyPress,
  pending: PendingKey | null,
): KeyOutcome {
  const key = e.key;
  if (key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey)
    return run({ type: "run", after: "stay" });
  if (key === "Enter" && e.altKey && !e.metaKey && !e.ctrlKey)
    return run({ type: "run", after: "insert" });
  if (e.metaKey || e.ctrlKey || e.altKey) return NONE;

  if (e.shiftKey) {
    if (key === "Enter") return run({ type: "run", after: "advance" });
    if (key === "M") return run({ type: "mergeBelow" });
    if (key === "Z") return run({ type: "redo" });
    if (key === "ArrowUp" || key === "K")
      return run({ type: "select", delta: -1 });
    if (key === "ArrowDown" || key === "J")
      return run({ type: "select", delta: 1 });
    return NONE;
  }

  if (key === "d" || key === "i" || key === "0") {
    return pending === key ? run(DOUBLE[key]) : { command: null, pending: key };
  }

  switch (key) {
    case "ArrowUp":
    case "k":
      return run({ type: "select", delta: -1 });
    case "ArrowDown":
    case "j":
      return run({ type: "select", delta: 1 });
    case "Enter":
      return run({ type: "edit" });
    case "a":
      return run({ type: "insert", where: "above" });
    case "b":
      return run({ type: "insert", where: "below" });
    case "m":
      return run({ type: "setType", cellType: "markdown" });
    case "y":
      return run({ type: "setType", cellType: "code" });
    case "r":
      return run({ type: "setType", cellType: "raw" });
    case "z":
      return run({ type: "undo" });
    default:
      return NONE;
  }
}

/** The cell `delta` steps from `key`, clamped to the ends. */
export function neighbourKey(
  keys: readonly string[],
  key: string | null,
  delta: number,
): string | null {
  if (keys.length === 0) return null;
  const i = key === null ? -1 : keys.indexOf(key);
  if (i === -1) return keys[0];
  return keys[Math.min(Math.max(i + delta, 0), keys.length - 1)];
}

// Kernel language → a file name the editor's language registry knows.
const LANGUAGE_FILE: Readonly<Record<string, string>> = {
  python: "cell.py",
  r: "cell.r",
  julia: "cell.jl",
  javascript: "cell.js",
  typescript: "cell.ts",
  rust: "cell.rs",
  go: "cell.go",
  cpp: "cell.cpp",
  c: "cell.c",
  java: "cell.java",
  scala: "cell.scala",
  kotlin: "cell.kt",
  csharp: "cell.cs",
  ruby: "cell.rb",
  sql: "cell.sql",
  bash: "cell.sh",
  sh: "cell.sh",
  lua: "cell.lua",
  haskell: "cell.hs",
  swift: "cell.swift",
};

/** The file name to resolve a cell's editor language from. */
export function cellFileName(
  cellType: CellType,
  language: string | null,
): string | null {
  if (cellType === "markdown") return "cell.md";
  if (cellType === "raw") return null;
  return language ? (LANGUAGE_FILE[language] ?? null) : null;
}
