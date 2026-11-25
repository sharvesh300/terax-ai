import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  chooseKernel,
  type KernelChoice,
  type KernelSpecInfo,
} from "../lib/chooseKernel";
import {
  type CellRunStatus,
  executeContent,
  type InputRequest,
  initialRunState,
  isRunning,
  type KernelMessage,
  type KernelStatus,
  kernelMetadata,
  queueRun,
  type RunState,
  reduceKernelMessage,
  stopAll,
} from "../lib/kernelRun";
import type { SessionEvent } from "../lib/session";
import type { ExecutionEvent, JsonObject, NotebookCell } from "../model";
import {
  interruptKernel,
  type KernelEvent,
  listKernelSpecs,
  sendToKernel,
  shutdownKernel,
  startKernel,
} from "./client";

/** "none": no kernel yet; "connecting": starting the process. */
export type KernelPhase = "none" | "connecting" | KernelStatus;

export type KernelView = {
  readonly phase: KernelPhase;
  readonly spec: KernelSpecInfo | null;
  readonly runs: Readonly<Record<string, CellRunStatus>>;
  readonly input: InputRequest | null;
  readonly busy: boolean;
  /** Why the last kernel stopped, when it died on its own. */
  readonly error: string | null;
};

export type KernelPicker = {
  readonly open: boolean;
  readonly specs: readonly KernelSpecInfo[] | null;
  readonly loading: boolean;
  readonly reason: Extract<KernelChoice, { kind: "pick" }>["reason"] | null;
};

const REMEMBER = "terax:notebook-kernel:";

function remembered(path: string): string | null {
  try {
    return localStorage.getItem(REMEMBER + path);
  } catch {
    return null;
  }
}
function remember(path: string, specId: string) {
  try {
    localStorage.setItem(REMEMBER + path, specId);
  } catch {
    // Private mode or blocked storage: the picker asks again next time.
  }
}

function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? path.slice(0, i + 1) || "/" : path.slice(0, i);
}

const newMsgId = () => crypto.randomUUID();
// Kernel output lands at most this often, so a flood of prints costs one
// render per frame instead of one per message.
const FLUSH_MS = 16;

type Options = {
  path: string;
  workspaceRoot: string | null;
  dispatch: (ev: SessionEvent) => void;
  /** The latest notebook, read when a run starts. */
  getDoc: () => { cells: readonly NotebookCell[]; metadata: JsonObject } | null;
};

/**
 * The notebook's kernel: picks one as Jupyter does (the notebook's own, else
 * ask), starts it on first run, runs cells, and turns everything the kernel
 * says into notebook changes. The kernel is shut down when the notebook
 * closes; nothing ever runs without the user asking.
 */
export function useKernel({ path, workspaceRoot, dispatch, getDoc }: Options) {
  const [view, setView] = useState<KernelView>({
    phase: "none",
    spec: null,
    runs: {},
    input: null,
    busy: false,
    error: null,
  });
  const [picker, setPicker] = useState<KernelPicker>({
    open: false,
    specs: null,
    loading: false,
    reason: null,
  });

  const kernelId = useRef<number | null>(null);
  const spec = useRef<KernelSpecInfo | null>(null);
  const run = useRef<RunState>(initialRunState);
  const phase = useRef<KernelPhase>("none");
  // Bumped per kernel; events from an older kernel are ignored.
  const generation = useRef(0);
  const pendingRun = useRef<string[] | null>(null);
  const shuttingDown = useRef(false);
  const buffered = useRef<ExecutionEvent[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ path, workspaceRoot, dispatch, getDoc });
  useLayoutEffect(() => {
    latest.current = { path, workspaceRoot, dispatch, getDoc };
  });

  const publish = useCallback((error?: string | null) => {
    const r = run.current;
    setView((v) => ({
      phase: phase.current,
      spec: spec.current,
      runs: r.runs,
      input: r.input,
      busy: isRunning(r),
      error: error === undefined ? v.error : error,
    }));
  }, []);

  const flush = useCallback(() => {
    flushTimer.current = null;
    const events = buffered.current;
    if (events.length > 0) {
      buffered.current = [];
      latest.current.dispatch({ type: "execution", events });
    }
    publish();
  }, [publish]);

  const schedule = useCallback(
    (events: readonly ExecutionEvent[]) => {
      if (events.length > 0) buffered.current.push(...events);
      if (flushTimer.current === null)
        flushTimer.current = setTimeout(flush, FLUSH_MS);
    },
    [flush],
  );

  const onEvent = useCallback(
    (gen: number, s: KernelSpecInfo) => (e: KernelEvent) => {
      if (gen !== generation.current) return;
      if (e.kind === "exited") {
        const expected = shuttingDown.current;
        kernelId.current = null;
        phase.current = expected ? "none" : "dead";
        run.current = stopAll(run.current, "dead");
        const tail = e.stderr.trim().split("\n").slice(-12).join("\n");
        schedule([]);
        if (!expected) {
          publish(
            tail ||
              `The kernel stopped${e.code !== null ? ` (exit code ${e.code})` : ""}.`,
          );
        }
        return;
      }
      const msg = e.message;
      if (
        e.channel === "shell" &&
        msg.header.msg_type === "kernel_info_reply"
      ) {
        schedule([
          {
            type: "setNotebookMetadata",
            patch: kernelMetadata(s, msg.content),
          },
        ]);
        return;
      }
      const result = reduceKernelMessage(
        run.current,
        e.channel,
        msg as KernelMessage,
      );
      run.current = result.state;
      if (result.state.status !== phase.current && phase.current !== "none")
        phase.current = result.state.status;
      schedule(result.events);
    },
    [publish, schedule],
  );

  const sendQueued = useCallback(
    async (keys: readonly string[]) => {
      const id = kernelId.current;
      const doc = latest.current.getDoc();
      if (id === null || !doc) return;
      for (const key of keys) {
        const cell = doc.cells.find((c) => c.key === key);
        if (cell?.cellType !== "code") continue;
        const msgId = newMsgId();
        const queued = queueRun(run.current, key, msgId);
        run.current = queued.state;
        schedule(queued.events);
        try {
          // Awaited one by one so the kernel receives them in order.
          await sendToKernel(
            id,
            "shell",
            "execute_request",
            executeContent(cell.source),
            {
              msgId,
            },
          );
        } catch (err) {
          run.current = stopAll(run.current, run.current.status);
          schedule([]);
          toast.error("Could not run the cell", { description: String(err) });
          return;
        }
      }
    },
    [schedule],
  );

  const start = useCallback(
    async (s: KernelSpecInfo) => {
      const gen = ++generation.current;
      spec.current = s;
      phase.current = "connecting";
      run.current = { ...initialRunState };
      shuttingDown.current = false;
      publish(null);
      try {
        const id = await startKernel(
          s.id,
          dirname(latest.current.path),
          onEvent(gen, s),
        );
        if (gen !== generation.current) {
          void shutdownKernel(id);
          return;
        }
        kernelId.current = id;
        phase.current = "starting";
        remember(latest.current.path, s.id);
        publish();
        void sendToKernel(id, "shell", "kernel_info_request", {});
        const pending = pendingRun.current;
        pendingRun.current = null;
        if (pending) await sendQueued(pending);
      } catch (err) {
        if (gen !== generation.current) return;
        phase.current = "none";
        pendingRun.current = null;
        publish(String(err));
      }
    },
    [onEvent, publish, sendQueued],
  );

  const loadSpecs = useCallback(async (refresh = false) => {
    setPicker((p) => ({ ...p, loading: true }));
    try {
      const specs = await listKernelSpecs(
        latest.current.workspaceRoot ?? dirname(latest.current.path),
        refresh,
      );
      setPicker((p) => ({ ...p, specs, loading: false }));
      return specs;
    } catch (err) {
      setPicker((p) => ({ ...p, loading: false }));
      toast.error("Could not list kernels", { description: String(err) });
      return null;
    }
  }, []);

  const openPicker = useCallback(
    (reason: KernelPicker["reason"] = null) => {
      setPicker((p) => ({ ...p, open: true, reason }));
      void loadSpecs();
    },
    [loadSpecs],
  );

  const closePicker = useCallback(() => {
    pendingRun.current = null;
    setPicker((p) => ({ ...p, open: false }));
  }, []);

  const shutdown = useCallback(async () => {
    const id = kernelId.current;
    generation.current++;
    kernelId.current = null;
    shuttingDown.current = true;
    phase.current = "none";
    run.current = stopAll(run.current, "dead");
    publish(null);
    if (id !== null) await shutdownKernel(id).catch(() => {});
  }, [publish]);

  const selectKernel = useCallback(
    async (s: KernelSpecInfo) => {
      setPicker((p) => ({ ...p, open: false }));
      const pending = pendingRun.current;
      if (kernelId.current !== null) await shutdown();
      pendingRun.current = pending;
      await start(s);
    },
    [shutdown, start],
  );

  /** Runs code cells in order, starting a kernel first if there is none. */
  const runCells = useCallback(
    async (keys: readonly string[]) => {
      if (keys.length === 0) return;
      if (kernelId.current !== null && phase.current !== "dead") {
        await sendQueued(keys);
        return;
      }
      if (phase.current === "connecting") {
        pendingRun.current = [...(pendingRun.current ?? []), ...keys];
        return;
      }
      pendingRun.current = [...keys];
      const specs = await loadSpecs();
      if (!specs) return;
      const doc = latest.current.getDoc();
      const choice = chooseKernel(
        specs,
        doc?.metadata ?? {},
        remembered(latest.current.path),
      );
      if (choice.kind === "use") await start(choice.spec);
      else setPicker((p) => ({ ...p, open: true, reason: choice.reason }));
    },
    [loadSpecs, sendQueued, start],
  );

  const interrupt = useCallback(async () => {
    const id = kernelId.current;
    if (id === null) return;
    await interruptKernel(id).catch((err) =>
      toast.error("Could not interrupt the kernel", {
        description: String(err),
      }),
    );
  }, []);

  const restart = useCallback(async () => {
    const s = spec.current;
    if (!s) return;
    await shutdown();
    await start(s);
  }, [shutdown, start]);

  const answerInput = useCallback(
    async (value: string) => {
      const id = kernelId.current;
      const req = run.current.input;
      if (id === null || !req) return;
      run.current = { ...run.current, input: null };
      // Keep what was asked and answered in the output, as Jupyter shows it.
      schedule([
        {
          type: "appendOutput",
          key: req.cellKey,
          output: {
            outputType: "stream",
            name: "stdout",
            text: `${req.prompt}${req.password ? "••••••••" : value}\n`,
            extra: {},
          },
        },
      ]);
      await sendToKernel(
        id,
        "stdin",
        "input_reply",
        { value },
        {
          parentHeader: req.header,
        },
      ).catch((err) =>
        toast.error("Could not send the input", { description: String(err) }),
      );
    },
    [schedule],
  );

  // A closed or retargeted notebook takes its kernel with it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: path is the trigger.
  useEffect(() => {
    return () => {
      if (flushTimer.current !== null) clearTimeout(flushTimer.current);
      const id = kernelId.current;
      generation.current++;
      kernelId.current = null;
      shuttingDown.current = true;
      if (id !== null) void shutdownKernel(id).catch(() => {});
    };
  }, [path]);

  return {
    view,
    picker,
    runCells,
    interrupt,
    restart,
    shutdown,
    selectKernel,
    openPicker,
    closePicker,
    refreshSpecs: () => loadSpecs(true),
    answerInput,
  };
}

export type KernelApi = ReturnType<typeof useKernel>;
