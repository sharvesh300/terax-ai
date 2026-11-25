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
  /** Shift+Enter: select the next cell (running comes with the kernel). */
  | { readonly type: "advance" };

export type KeyPress = {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
};

export type KeyOutcome = {
  readonly command: NotebookCommand | null;
  /** The first D of "D D" (delete) was pressed; the next key decides. */
  readonly pendingDelete: boolean;
};

const NONE: KeyOutcome = { command: null, pendingDelete: false };
const run = (command: NotebookCommand): KeyOutcome => ({
  command,
  pendingDelete: false,
});

/**
 * The command for a key press in command mode. Chords with Cmd, Ctrl or Alt
 * are never notebook keys: they belong to the app's shortcuts (Cmd+S, …).
 */
export function commandModeKey(
  e: KeyPress,
  pendingDelete: boolean,
): KeyOutcome {
  if (e.metaKey || e.ctrlKey || e.altKey) return NONE;
  const key = e.key;

  if (e.shiftKey) {
    if (key === "Enter") return run({ type: "advance" });
    if (key === "M") return run({ type: "mergeBelow" });
    if (key === "Z") return run({ type: "redo" });
    if (key === "ArrowUp" || key === "K")
      return run({ type: "select", delta: -1 });
    if (key === "ArrowDown" || key === "J")
      return run({ type: "select", delta: 1 });
    return NONE;
  }

  switch (key) {
    case "d":
      return pendingDelete
        ? run({ type: "delete" })
        : { command: null, pendingDelete: true };
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
