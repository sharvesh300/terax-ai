import { describe, expect, it } from "vitest";
import {
  executeContent,
  initialRunState,
  isRunning,
  type KernelMessage,
  kernelMetadata,
  queueRun,
  type RunState,
  reduceKernelMessage,
  stopAll,
} from "./kernelRun";

const msg = (
  msg_type: string,
  parent: string | null,
  content: Record<string, unknown> = {},
): KernelMessage => ({
  header: { msg_id: `${msg_type}-${Math.random()}`, msg_type },
  parent_header: parent ? { msg_id: parent } : null,
  content: content as KernelMessage["content"],
});

function feed(state: RunState, ...steps: [string, KernelMessage][]) {
  const events = [];
  let s = state;
  for (const [channel, m] of steps) {
    const r = reduceKernelMessage(s, channel, m);
    s = r.state;
    events.push(...r.events);
  }
  return { state: s, events };
}

describe("queueRun", () => {
  it("clears the cell and remembers which request runs it", () => {
    const r = queueRun(initialRunState, "c1", "m1");
    expect(r.state.cellByMsg).toEqual({ m1: "c1" });
    expect(r.state.runs.c1).toBe("queued");
    expect(r.events).toEqual([
      { type: "setOutputs", key: "c1", outputs: [] },
      { type: "setExecutionCount", key: "c1", count: null },
    ]);
    // Rerunning drops the old request, so its late output is ignored.
    const again = queueRun(r.state, "c1", "m2");
    expect(again.state.cellByMsg).toEqual({ m2: "c1" });
  });

  it("asks the kernel to stop at the first error", () => {
    expect(executeContent("x")).toMatchObject({
      code: "x",
      stop_on_error: true,
      allow_stdin: true,
    });
  });
});

describe("reduceKernelMessage", () => {
  const queued = queueRun(initialRunState, "c1", "m1").state;

  it("turns a run into a count, outputs and a finished cell", () => {
    const { state, events } = feed(
      queued,
      ["iopub", msg("status", "m1", { execution_state: "busy" })],
      ["iopub", msg("execute_input", "m1", { code: "x", execution_count: 4 })],
      ["iopub", msg("stream", "m1", { name: "stdout", text: "hi\n" })],
      [
        "iopub",
        msg("execute_result", "m1", {
          execution_count: 4,
          data: { "text/plain": "2" },
          metadata: {},
        }),
      ],
      ["iopub", msg("status", "m1", { execution_state: "idle" })],
      [
        "shell",
        msg("execute_reply", "m1", { status: "ok", execution_count: 4 }),
      ],
    );
    expect(state.status).toBe("idle");
    expect(state.runs.c1).toBe("done");
    expect(isRunning(state)).toBe(false);
    expect(events).toEqual([
      { type: "setExecutionCount", key: "c1", count: 4 },
      {
        type: "appendOutput",
        key: "c1",
        output: {
          outputType: "stream",
          name: "stdout",
          text: "hi\n",
          extra: {},
        },
      },
      {
        type: "appendOutput",
        key: "c1",
        output: expect.objectContaining({
          outputType: "execute_result",
          executionCount: 4,
          data: { "text/plain": "2" },
        }),
      },
      { type: "setExecutionCount", key: "c1", count: 4 },
    ]);
  });

  it("marks errors and aborted cells, as stop_on_error leaves them", () => {
    const two = queueRun(queued, "c2", "m2").state;
    const { state, events } = feed(
      two,
      [
        "iopub",
        msg("error", "m1", { ename: "E", evalue: "v", traceback: ["E: v"] }),
      ],
      ["shell", msg("execute_reply", "m1", { status: "error" })],
      ["shell", msg("execute_reply", "m2", { status: "aborted" })],
    );
    expect(state.runs).toEqual({ c1: "error", c2: "aborted" });
    expect(events[0]).toMatchObject({
      type: "appendOutput",
      output: { outputType: "error", ename: "E" },
    });
  });

  it("clears now, or on the next output when asked to wait", () => {
    const now = feed(queued, [
      "iopub",
      msg("clear_output", "m1", { wait: false }),
    ]);
    expect(now.events).toEqual([
      { type: "setOutputs", key: "c1", outputs: [] },
    ]);
    const later = feed(
      queued,
      ["iopub", msg("clear_output", "m1", { wait: true })],
      ["iopub", msg("stream", "m1", { name: "stdout", text: "50%" })],
      ["iopub", msg("stream", "m1", { name: "stdout", text: "more" })],
    );
    expect(later.events.map((e) => e.type)).toEqual([
      "setOutputs",
      "appendOutput",
      "appendOutput",
    ]);
  });

  it("keeps display ids and applies display updates", () => {
    const { events } = feed(
      queued,
      [
        "iopub",
        msg("display_data", "m1", {
          data: { "text/plain": "0%" },
          metadata: {},
          transient: { display_id: "bar" },
        }),
      ],
      [
        "iopub",
        msg("update_display_data", "m1", {
          data: { "text/plain": "100%" },
          metadata: {},
          transient: { display_id: "bar" },
        }),
      ],
    );
    expect(events[0]).toMatchObject({ output: { displayId: "bar" } });
    expect(events[1]).toEqual({
      type: "updateDisplay",
      displayId: "bar",
      data: { "text/plain": "100%" },
      metadata: {},
    });
  });

  it("holds an input request for the cell that asked", () => {
    const { state } = feed(queued, [
      "stdin",
      msg("input_request", "m1", { prompt: "Name? ", password: false }),
    ]);
    expect(state.input).toMatchObject({
      cellKey: "c1",
      prompt: "Name? ",
      password: false,
    });
    expect(state.input?.header).toMatchObject({ msg_type: "input_request" });
  });

  it("ignores messages for requests it does not know", () => {
    const { state, events } = feed(queued, [
      "iopub",
      msg("stream", "other", { name: "stdout", text: "x" }),
    ]);
    expect(state).toBe(queued);
    expect(events).toEqual([]);
  });
});

describe("stopAll", () => {
  it("aborts what was queued or running when the kernel goes away", () => {
    let s = queueRun(initialRunState, "c1", "m1").state;
    s = { ...s, runs: { ...s.runs, c0: "done" } };
    const stopped = stopAll(s, "dead");
    expect(stopped.runs).toEqual({ c1: "aborted", c0: "done" });
    expect(stopped.cellByMsg).toEqual({});
    expect(stopped.status).toBe("dead");
  });
});

describe("kernelMetadata", () => {
  it("writes the kernelspec and the kernel's language_info, as Jupyter does", () => {
    expect(
      kernelMetadata(
        {
          name: "python3",
          displayName: "Python 3 (.venv)",
          language: "python",
        },
        { language_info: { name: "python", version: "3.12.4" } },
      ),
    ).toEqual({
      kernelspec: {
        display_name: "Python 3 (.venv)",
        language: "python",
        name: "python3",
      },
      language_info: { name: "python", version: "3.12.4" },
    });
  });
});
