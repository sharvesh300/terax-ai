// A scripted stand-in for the Rust kernel host and an ipykernel, speaking
// the same messages, so running cells can be tried in a browser. It does not
// evaluate Python: it recognises a few forms.
//
//   print("text")        stdout
//   sleep(3)              busy for 3 s (interruptible, I I)
//   input("Prompt? ")    asks for input, then prints Hello <answer>
//   progress()            a carriage-return progress bar
//   1/0                   ZeroDivisionError (stop_on_error aborts the rest)
//   any other last line   its text as the result (Out[n])

type Json = Record<string, unknown>;
type Emit = (event: Json) => void;

type Kernel = {
  emit: Emit;
  count: number;
  queue: Promise<void>;
  interrupted: boolean;
  failedAt: number;
  pendingInput: ((value: string) => void) | null;
};

const kernels = new Map<number, Kernel>();
let nextId = 0;

const SPECS = [
  {
    id: "kernelspec:/usr/local/share/jupyter/kernels/python3",
    name: "python3",
    displayName: "Python 3 (ipykernel)",
    language: "python",
    source: "kernelspec",
    path: "/usr/local/share/jupyter/kernels/python3",
    ready: true,
  },
  {
    id: "environment:/demo/.venv/bin/python",
    name: "python3",
    displayName: "Python 3.12.4 (.venv)",
    language: "python",
    source: "environment",
    path: "/demo/.venv/bin/python",
    ready: true,
    python: "/demo/.venv/bin/python",
  },
  {
    id: "environment:/usr/bin/python3",
    name: "python3",
    displayName: "Python 3.9.6 (PATH)",
    language: "python",
    source: "environment",
    path: "/usr/bin/python3",
    ready: false,
    python: "/usr/bin/python3",
  },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => crypto.randomUUID();

function message(
  k: Kernel,
  channel: string,
  msgType: string,
  parentId: string | null,
  content: Json,
): Json {
  const header = {
    msg_id: uid(),
    msg_type: msgType,
    session: "fake",
    username: "kernel",
    date: new Date().toISOString(),
    version: "5.3",
  };
  k.emit({
    kind: "message",
    channel,
    message: {
      header,
      parent_header: parentId ? { msg_id: parentId } : null,
      metadata: {},
      content,
      channel,
    },
  });
  return header;
}

async function execute(k: Kernel, msgId: string, code: string, received: number) {
  const iopub = (type: string, content: Json) =>
    message(k, "iopub", type, msgId, content);
  if (received < k.failedAt) {
    message(k, "shell", "execute_reply", msgId, {
      status: "aborted",
      execution_count: null,
    });
    return;
  }
  iopub("status", { execution_state: "busy" });
  const count = ++k.count;
  iopub("execute_input", { code, execution_count: count });
  k.interrupted = false;
  let error: Json | null = null;
  const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const print = /^print\((['"])(.*)\1\)$/.exec(line);
    const sleep = /^(?:time\.)?sleep\((\d+(?:\.\d+)?)\)$/.exec(line);
    const input = /^input\((['"])(.*)\1\)$/.exec(line);
    if (print) {
      iopub("stream", { name: "stdout", text: `${print[2]}\n` });
    } else if (sleep) {
      const until = Date.now() + Number(sleep[1]) * 1000;
      while (Date.now() < until && !k.interrupted) await wait(50);
      if (k.interrupted) {
        error = {
          ename: "KeyboardInterrupt",
          evalue: "",
          traceback: ["\x1b[0;31mKeyboardInterrupt\x1b[0m: "],
        };
        break;
      }
    } else if (input) {
      const header = message(k, "stdin", "input_request", msgId, {
        prompt: input[2],
        password: false,
      });
      void header;
      const value = await new Promise<string>((resolve) => {
        k.pendingInput = resolve;
      });
      iopub("stream", { name: "stdout", text: `Hello ${value}\n` });
    } else if (line === "progress()") {
      for (let p = 0; p <= 100; p += 10) {
        iopub("stream", { name: "stderr", text: `\r${p}%|${"█".repeat(p / 10)}` });
        await wait(80);
      }
      iopub("stream", { name: "stderr", text: "\n" });
    } else if (line === "1/0") {
      error = {
        ename: "ZeroDivisionError",
        evalue: "division by zero",
        traceback: [
          "\x1b[0;31m---------------------------------------------------------------------------\x1b[0m",
          "\x1b[0;31mZeroDivisionError\x1b[0m: division by zero",
        ],
      };
      break;
    } else if (i === lines.length - 1 && !line.includes("=") && !line.startsWith("import")) {
      iopub("execute_result", {
        execution_count: count,
        data: { "text/plain": line },
        metadata: {},
      });
    }
    await wait(30);
  }
  if (error) {
    iopub("error", error);
    k.failedAt = Date.now();
  }
  iopub("status", { execution_state: "idle" });
  message(k, "shell", "execute_reply", msgId, {
    status: error ? "error" : "ok",
    execution_count: count,
    ...(error ?? {}),
  });
}

/** Answers the kernel_* commands; returns undefined for anything else. */
export function fakeKernelCommand(cmd: string, a: Json): unknown {
  switch (cmd) {
    case "kernel_list_specs":
      return wait(300).then(() => SPECS);
    case "kernel_start": {
      const channel = a.onEvent as { onmessage: (e: Json) => void };
      const id = ++nextId;
      const k: Kernel = {
        emit: (e) => channel.onmessage(e),
        count: 0,
        queue: Promise.resolve(),
        interrupted: false,
        failedAt: 0,
        pendingInput: null,
      };
      kernels.set(id, k);
      return wait(400).then(() => {
        message(k, "iopub", "status", null, { execution_state: "starting" });
        setTimeout(() => message(k, "iopub", "status", null, { execution_state: "idle" }), 200);
        return id;
      });
    }
    case "kernel_send": {
      const k = kernels.get(a.id as number);
      if (!k) return Promise.reject(`kernel ${a.id} is not running`);
      const msgId = (a.msgId as string | null) ?? uid();
      const content = a.content as Json;
      if (a.msgType === "kernel_info_request") {
        setTimeout(
          () =>
            message(k, "shell", "kernel_info_reply", msgId, {
              status: "ok",
              language_info: { name: "python", version: "3.12.4" },
            }),
          50,
        );
      } else if (a.msgType === "execute_request") {
        const received = Date.now();
        k.queue = k.queue.then(() => execute(k, msgId, content.code as string, received));
      } else if (a.msgType === "input_reply") {
        k.pendingInput?.(content.value as string);
        k.pendingInput = null;
      }
      return msgId;
    }
    case "kernel_interrupt": {
      const k = kernels.get(a.id as number);
      if (k) k.interrupted = true;
      return null;
    }
    case "kernel_shutdown": {
      const k = kernels.get(a.id as number);
      kernels.delete(a.id as number);
      if (k) setTimeout(() => k.emit({ kind: "exited", code: 0, stderr: "" }), 30);
      return null;
    }
    default:
      return undefined;
  }
}
