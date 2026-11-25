// Thin wrapper over the kernel host commands (src-tauri modules/kernel).

import { Channel, invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";
import type { KernelSpecInfo } from "../lib/chooseKernel";
import type { KernelMessage } from "../lib/kernelRun";
import type { JsonObject } from "../model";

export type KernelEvent =
  | {
      readonly kind: "message";
      readonly channel: "iopub" | "shell" | "control" | "stdin";
      readonly message: KernelMessage;
    }
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly stderr: string;
    };

export function listKernelSpecs(
  workspaceRoot: string | null,
  refresh = false,
): Promise<KernelSpecInfo[]> {
  return invoke<KernelSpecInfo[]>("kernel_list_specs", {
    workspaceRoot,
    refresh,
  });
}

export async function startKernel(
  specId: string,
  cwd: string,
  onEvent: (e: KernelEvent) => void,
): Promise<number> {
  const channel = new Channel<KernelEvent>(onEvent);
  return invoke<number>("kernel_start", {
    specId,
    cwd,
    workspace: currentWorkspaceEnv(),
    onEvent: channel,
  });
}

/** Returns the message id replies and outputs will name as their parent. */
export function sendToKernel(
  id: number,
  channel: "shell" | "control" | "stdin",
  msgType: string,
  content: JsonObject,
  opts: { parentHeader?: JsonObject; msgId?: string } = {},
): Promise<string> {
  return invoke<string>("kernel_send", {
    id,
    channel,
    msgType,
    content,
    parentHeader: opts.parentHeader ?? null,
    msgId: opts.msgId ?? null,
  });
}

export function interruptKernel(id: number): Promise<void> {
  return invoke("kernel_interrupt", { id });
}

export function shutdownKernel(id: number): Promise<void> {
  return invoke("kernel_shutdown", { id });
}
