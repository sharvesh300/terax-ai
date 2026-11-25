import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { serializeNotebook } from "../model";
import {
  initialSession,
  type ReadResult,
  type SessionEvent,
  type SessionState,
  sessionDirty,
  sessionReducer,
} from "./session";

const fixture = readFileSync(
  new URL("../model/__fixtures__/jupyter-4.5.ipynb", import.meta.url),
  "utf8",
);
const text = (content: string, mtime = 1): ReadResult => ({
  kind: "text",
  content,
  size: content.length,
  mtime,
});
const run = (state: SessionState, ...events: SessionEvent[]) =>
  events.reduce((s, e) => sessionReducer(s, e), state);
const ready = (s: SessionState) => {
  if (s.kind !== "ready") throw new Error(`not ready: ${s.kind}`);
  return s;
};

function loaded() {
  return ready(run(initialSession, { type: "read", result: text(fixture) }));
}
const firstKey = (s: SessionState) => ready(s).history.present.doc.cells[0].key;
const edit = (
  s: SessionState,
  source: string,
  group?: string,
): SessionEvent => ({
  type: "edit",
  edit: { type: "setSource", key: firstKey(s), source },
  group,
});

describe("sessionReducer", () => {
  it("reads a notebook, or explains why it cannot", () => {
    expect(loaded().history.present.doc.cells).toHaveLength(6);
    expect(sessionDirty(loaded())).toBe(false);
    const bad = run(initialSession, { type: "read", result: text("{}") });
    expect(bad).toMatchObject({
      kind: "invalid",
      error: { kind: "not-notebook" },
    });
    expect(
      run(initialSession, {
        type: "read",
        result: { kind: "binary", size: 3 },
      }),
    ).toEqual({ kind: "binary" });
    expect(
      run(initialSession, { type: "readFailed", message: "denied" }),
    ).toEqual({ kind: "error", message: "denied" });
  });

  it("applies edits to the latest document, merging typing into one step", () => {
    let s: SessionState = loaded();
    s = run(s, edit(s, "a", "t"), edit(s, "ab", "t"), edit(s, "abc", "t"));
    const r = ready(s);
    expect(r.history.present.doc.cells[0].source).toBe("abc");
    expect(r.history.past).toHaveLength(1);
    expect(sessionDirty(s)).toBe(true);
    s = run(s, { type: "undo" });
    expect(sessionDirty(s)).toBe(false);
    s = run(s, { type: "redo" });
    expect(ready(s).history.present.doc.cells[0].source).toBe("abc");
  });

  it("ignores our own save coming back from the watcher", () => {
    let s: SessionState = loaded();
    s = run(s, edit(s, "x"));
    const doc = ready(s).history.present.doc;
    const written = serializeNotebook(doc);
    s = run(s, { type: "saved", doc, disk: { text: written, mtime: 2 } });
    expect(sessionDirty(s)).toBe(false);
    const after = run(s, { type: "read", result: text(written, 2) });
    expect(after).toBe(s);
  });

  it("keeps edits typed while a save was in flight unsaved", () => {
    let s: SessionState = loaded();
    s = run(s, edit(s, "x"));
    const doc = ready(s).history.present.doc;
    s = run(s, edit(s, "xy"));
    s = run(s, {
      type: "saved",
      doc,
      disk: { text: serializeNotebook(doc), mtime: 2 },
    });
    expect(sessionDirty(s)).toBe(true);
  });

  it("reloads a clean notebook that changed on disk", () => {
    const s = loaded();
    const changed = fixture.replace("Analysis", "Report");
    const next = ready(run(s, { type: "read", result: text(changed, 5) }));
    expect(next.history.present.doc.cells[0].source).toContain("Report");
    expect(next.disk).toEqual({ text: changed, mtime: 5 });
  });

  it("never drops unsaved edits for a change on disk", () => {
    let s: SessionState = loaded();
    s = run(s, edit(s, "mine"));
    const changed = fixture.replace("Analysis", "Report");
    s = run(s, { type: "read", result: text(changed, 5) });
    const r = ready(s);
    expect(r.history.present.doc.cells[0].source).toBe("mine");
    expect(r.changedOnDisk).toEqual({ text: changed, mtime: 5 });
    // Or an unreadable file.
    expect(run(s, { type: "read", result: { kind: "binary", size: 1 } })).toBe(
      s,
    );
    expect(run(s, { type: "readFailed", message: "gone" })).toBe(s);
  });

  it("lets the user keep their edits or take the file", () => {
    let s: SessionState = loaded();
    s = run(s, edit(s, "mine"));
    const changed = fixture.replace("Analysis", "Report");
    s = run(s, { type: "read", result: text(changed, 5) });
    const kept = ready(run(s, { type: "keepMine" }));
    expect(kept.changedOnDisk).toBeNull();
    // Their version is the new baseline, so saving will not warn again.
    expect(kept.disk).toEqual({ text: changed, mtime: 5 });
    expect(sessionDirty(kept)).toBe(true);
    const taken = ready(
      run(s, { type: "read", result: text(changed, 5), discard: true }),
    );
    expect(taken.history.present.doc.cells[0].source).toContain("Report");
    expect(sessionDirty(taken)).toBe(false);
  });

  it("ignores edits and saves before a notebook is ready", () => {
    expect(run(initialSession, { type: "undo" })).toBe(initialSession);
    expect(
      run(initialSession, {
        type: "edit",
        edit: { type: "clearOutputs" },
      }),
    ).toBe(initialSession);
  });
});
