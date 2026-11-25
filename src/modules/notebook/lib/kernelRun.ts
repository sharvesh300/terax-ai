// Kernel messages → notebook changes. Pure: the hook feeds it every message
// the kernel host forwards and applies the execution events it returns.

import {
  type ExecutionEvent,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type NotebookOutput,
  normalizeOutput,
} from "../model";

/** A Jupyter message as the kernel host forwards it. */
export type KernelMessage = {
  readonly header: { readonly msg_id: string; readonly msg_type: string };
  readonly parent_header: { readonly msg_id?: string } | null;
  readonly content: JsonObject;
  readonly metadata?: JsonObject;
};

export type KernelStatus = "starting" | "idle" | "busy" | "restarting" | "dead";

export type CellRunStatus = "queued" | "running" | "done" | "error" | "aborted";

/** An `input()` waiting for the user. */
export type InputRequest = {
  readonly cellKey: string;
  readonly prompt: string;
  readonly password: boolean;
  /** The request's header, sent back as the reply's parent. */
  readonly header: JsonObject;
};

export type RunState = {
  readonly status: KernelStatus;
  /** Which cell each execute_request belongs to. */
  readonly cellByMsg: Readonly<Record<string, string>>;
  readonly runs: Readonly<Record<string, CellRunStatus>>;
  /** Cells whose outputs clear when their next output arrives. */
  readonly clearOnNext: Readonly<Record<string, true>>;
  readonly input: InputRequest | null;
};

export const initialRunState: RunState = {
  status: "starting",
  cellByMsg: {},
  runs: {},
  clearOnNext: {},
  input: null,
};

export type RunResult = {
  readonly state: RunState;
  readonly events: readonly ExecutionEvent[];
};

const same = (state: RunState): RunResult => ({ state, events: [] });

/** The content of an execute_request for one cell. */
export function executeContent(code: string): JsonObject {
  return {
    code,
    silent: false,
    store_history: true,
    user_expressions: {},
    allow_stdin: true,
    // A failing cell stops the cells queued after it, as in Jupyter.
    stop_on_error: true,
  };
}

/** Records that `msgId` runs `cellKey`, and the events that start it. */
export function queueRun(
  state: RunState,
  cellKey: string,
  msgId: string,
): RunResult {
  // A cell rerun before its last run ended: forget the old request.
  const cellByMsg: Record<string, string> = {};
  for (const [id, key] of Object.entries(state.cellByMsg)) {
    if (key !== cellKey) cellByMsg[id] = key;
  }
  cellByMsg[msgId] = cellKey;
  const { [cellKey]: _cleared, ...clearOnNext } = state.clearOnNext;
  return {
    state: {
      ...state,
      cellByMsg,
      clearOnNext,
      runs: { ...state.runs, [cellKey]: "queued" },
    },
    events: [
      { type: "setOutputs", key: cellKey, outputs: [] },
      { type: "setExecutionCount", key: cellKey, count: null },
    ],
  };
}

function withRun(
  state: RunState,
  key: string,
  status: CellRunStatus,
): RunState {
  return state.runs[key] === status
    ? state
    : { ...state, runs: { ...state.runs, [key]: status } };
}

const str = (v: JsonValue | undefined, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

function outputFrom(msgType: string, content: JsonObject): NotebookOutput {
  const output = normalizeOutput({ ...content, output_type: msgType });
  const transient = content.transient;
  const displayId =
    isJsonObject(transient) && typeof transient.display_id === "string"
      ? transient.display_id
      : null;
  if (
    displayId !== null &&
    (output.outputType === "display_data" ||
      output.outputType === "execute_result")
  ) {
    return { ...output, displayId };
  }
  return output;
}

/** Applies one kernel message to the run state. */
export function reduceKernelMessage(
  state: RunState,
  channel: string,
  msg: KernelMessage,
): RunResult {
  const type = msg.header.msg_type;
  const parent = msg.parent_header?.msg_id;
  const cellKey = parent !== undefined ? state.cellByMsg[parent] : undefined;
  const c = msg.content;

  if (channel === "iopub" && type === "status") {
    const s = str(c.execution_state);
    let next = state;
    if (
      s === "busy" ||
      s === "idle" ||
      s === "starting" ||
      s === "restarting"
    ) {
      const status: KernelStatus = s;
      // Only the kernel's own state counts; our requests' busy/idle pairs
      // are what mark cells running and done.
      if (next.status !== status) next = { ...next, status };
    }
    if (cellKey !== undefined) {
      if (s === "busy" && next.runs[cellKey] === "queued")
        next = withRun(next, cellKey, "running");
      if (s === "idle" && next.runs[cellKey] === "running")
        next = withRun(next, cellKey, "done");
    }
    return same(next);
  }

  if (
    channel === "shell" &&
    type === "execute_reply" &&
    cellKey !== undefined
  ) {
    const status = str(c.status);
    const run = state.runs[cellKey];
    if (status === "error") return same(withRun(state, cellKey, "error"));
    // stop_on_error: cells queued after a failure are aborted unrun.
    if (status === "aborted") return same(withRun(state, cellKey, "aborted"));
    if (run === "queued" || run === "running")
      return same(withRun(state, cellKey, "done"));
    return same(state);
  }

  if (channel === "stdin" && type === "input_request") {
    if (cellKey === undefined) return same(state);
    return same({
      ...state,
      input: {
        cellKey,
        prompt: str(c.prompt),
        password: c.password === true,
        header: msg.header as unknown as JsonObject,
      },
    });
  }

  if (channel !== "iopub" || cellKey === undefined) return same(state);

  switch (type) {
    case "execute_input": {
      const count =
        typeof c.execution_count === "number" ? c.execution_count : null;
      return {
        state: withRun(state, cellKey, "running"),
        events: [{ type: "setExecutionCount", key: cellKey, count }],
      };
    }
    case "clear_output": {
      if (c.wait === true) {
        return same({
          ...state,
          clearOnNext: { ...state.clearOnNext, [cellKey]: true },
        });
      }
      return {
        state,
        events: [{ type: "setOutputs", key: cellKey, outputs: [] }],
      };
    }
    case "stream":
    case "display_data":
    case "execute_result":
    case "error": {
      const events: ExecutionEvent[] = [];
      let next = state;
      if (state.clearOnNext[cellKey]) {
        const { [cellKey]: _done, ...rest } = state.clearOnNext;
        next = { ...state, clearOnNext: rest };
        events.push({ type: "setOutputs", key: cellKey, outputs: [] });
      }
      events.push({
        type: "appendOutput",
        key: cellKey,
        output: outputFrom(type, c),
      });
      if (type === "execute_result" && typeof c.execution_count === "number") {
        events.push({
          type: "setExecutionCount",
          key: cellKey,
          count: c.execution_count,
        });
      }
      if (type === "error") next = withRun(next, cellKey, "error");
      return { state: next, events };
    }
    case "update_display_data": {
      const transient = c.transient;
      const displayId =
        isJsonObject(transient) && typeof transient.display_id === "string"
          ? transient.display_id
          : null;
      if (displayId === null) return same(state);
      const out = outputFrom("display_data", c);
      if (out.outputType !== "display_data") return same(state);
      return {
        state,
        events: [
          {
            type: "updateDisplay",
            displayId,
            data: out.data,
            metadata: out.metadata,
          },
        ],
      };
    }
    default:
      return same(state);
  }
}

/** The kernel died or restarted: nothing it was running will finish. */
export function stopAll(state: RunState, status: KernelStatus): RunState {
  const runs: Record<string, CellRunStatus> = {};
  for (const [key, run] of Object.entries(state.runs)) {
    runs[key] = run === "queued" || run === "running" ? "aborted" : run;
  }
  return {
    ...state,
    status,
    runs,
    cellByMsg: {},
    clearOnNext: {},
    input: null,
  };
}

export function isRunning(state: RunState): boolean {
  return Object.values(state.runs).some(
    (r) => r === "queued" || r === "running",
  );
}

/**
 * Notebook metadata from a kernel_info_reply, as Jupyter writes it when a
 * kernel starts: the kernelspec that was chosen and the language it reports.
 */
export function kernelMetadata(
  spec: {
    readonly name: string;
    readonly displayName: string;
    readonly language: string;
  },
  reply: JsonObject,
): JsonObject {
  const info = isJsonObject(reply.language_info) ? reply.language_info : null;
  return {
    kernelspec: {
      display_name: spec.displayName,
      language: spec.language,
      name: spec.name,
    },
    ...(info ? { language_info: info } : {}),
  };
}
