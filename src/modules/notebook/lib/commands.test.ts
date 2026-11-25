import { describe, expect, it } from "vitest";
import {
  cellFileName,
  commandModeKey,
  type KeyPress,
  neighbourKey,
} from "./commands";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});
const cmd = (
  key: string,
  mods?: Partial<KeyPress>,
  pending: "d" | "i" | "0" | null = null,
) => commandModeKey(press(key, mods), pending).command;

describe("commandModeKey", () => {
  it("maps Jupyter's command-mode keys", () => {
    expect(cmd("a")).toEqual({ type: "insert", where: "above" });
    expect(cmd("b")).toEqual({ type: "insert", where: "below" });
    expect(cmd("m")).toEqual({ type: "setType", cellType: "markdown" });
    expect(cmd("y")).toEqual({ type: "setType", cellType: "code" });
    expect(cmd("r")).toEqual({ type: "setType", cellType: "raw" });
    expect(cmd("Enter")).toEqual({ type: "edit" });
    expect(cmd("ArrowDown")).toEqual({ type: "select", delta: 1 });
    expect(cmd("k")).toEqual({ type: "select", delta: -1 });
    expect(cmd("z")).toEqual({ type: "undo" });
    expect(cmd("Z", { shiftKey: true })).toEqual({ type: "redo" });
    expect(cmd("M", { shiftKey: true })).toEqual({ type: "mergeBelow" });
    expect(cmd("Enter", { shiftKey: true })).toEqual({
      type: "run",
      after: "advance",
    });
    expect(cmd("Enter", { ctrlKey: true })).toEqual({
      type: "run",
      after: "stay",
    });
    expect(cmd("Enter", { metaKey: true })).toEqual({
      type: "run",
      after: "stay",
    });
    expect(cmd("Enter", { altKey: true })).toEqual({
      type: "run",
      after: "insert",
    });
  });

  it("deletes on D D, interrupts on I I and restarts on 0 0", () => {
    expect(commandModeKey(press("d"), null)).toEqual({
      command: null,
      pending: "d",
    });
    expect(cmd("d", {}, "d")).toEqual({ type: "delete" });
    expect(cmd("i", {}, "i")).toEqual({ type: "interrupt" });
    expect(cmd("0", {}, "0")).toEqual({ type: "restart" });
    // A different second key starts over; any other key cancels.
    expect(commandModeKey(press("i"), "d")).toEqual({
      command: null,
      pending: "i",
    });
    expect(commandModeKey(press("j"), "d").pending).toBeNull();
  });

  it("leaves chords with Cmd, Ctrl or Alt to the app", () => {
    expect(cmd("z", { metaKey: true })).toBeNull();
    expect(cmd("s", { ctrlKey: true })).toBeNull();
    expect(cmd("a", { altKey: true })).toBeNull();
    expect(cmd("x")).toBeNull();
  });
});

describe("neighbourKey", () => {
  it("steps and clamps at the ends", () => {
    const keys = ["a", "b", "c"];
    expect(neighbourKey(keys, "b", 1)).toBe("c");
    expect(neighbourKey(keys, "c", 1)).toBe("c");
    expect(neighbourKey(keys, "a", -1)).toBe("a");
    expect(neighbourKey(keys, "gone", 1)).toBe("a");
    expect(neighbourKey([], "a", 1)).toBeNull();
  });
});

describe("cellFileName", () => {
  it("picks the editor language by cell type and kernel", () => {
    expect(cellFileName("code", "python")).toBe("cell.py");
    expect(cellFileName("code", "cobol")).toBeNull();
    expect(cellFileName("code", null)).toBeNull();
    expect(cellFileName("markdown", "python")).toBe("cell.md");
    expect(cellFileName("raw", "python")).toBeNull();
  });
});
