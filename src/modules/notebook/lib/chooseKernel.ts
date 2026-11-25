// Which kernel a notebook starts with, as Jupyter decides it: the kernel the
// notebook names if it exists, else ask. Pure.

import { isJsonObject, type JsonObject } from "../model";

/** What the kernel host lists (`kernel_list_specs`). */
export type KernelSpecInfo = {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly language: string;
  readonly source: "kernelspec" | "environment";
  readonly path: string;
  /** False: a Python found on disk that needs ipykernel installed. */
  readonly ready: boolean;
  readonly python?: string;
};

export type KernelChoice =
  | { readonly kind: "use"; readonly spec: KernelSpecInfo }
  | {
      readonly kind: "pick";
      readonly reason: "none" | "missing" | "ambiguous";
    };

function wanted(metadata: JsonObject): {
  name: string | null;
  language: string | null;
} {
  const spec = isJsonObject(metadata.kernelspec) ? metadata.kernelspec : {};
  const info = isJsonObject(metadata.language_info)
    ? metadata.language_info
    : {};
  const name = typeof spec.name === "string" ? spec.name : null;
  const language =
    typeof spec.language === "string"
      ? spec.language
      : typeof info.name === "string"
        ? info.name
        : null;
  return { name, language: language?.toLowerCase() ?? null };
}

export function chooseKernel(
  specs: readonly KernelSpecInfo[],
  metadata: JsonObject,
  rememberedId: string | null,
): KernelChoice {
  const ready = specs.filter((s) => s.ready);
  const remembered = ready.find((s) => s.id === rememberedId);
  if (remembered) return { kind: "use", spec: remembered };
  if (ready.length === 0) return { kind: "pick", reason: "none" };

  const { name, language } = wanted(metadata);
  if (name !== null) {
    // An installed kernel of that name, as Jupyter would start.
    const installed = ready.filter(
      (s) => s.source === "kernelspec" && s.name === name,
    );
    if (installed.length === 1) return { kind: "use", spec: installed[0] };
  }
  if (language !== null) {
    const sameLanguage = ready.filter(
      (s) => s.language.toLowerCase() === language,
    );
    if (sameLanguage.length === 1)
      return { kind: "use", spec: sameLanguage[0] };
    return {
      kind: "pick",
      reason: sameLanguage.length === 0 ? "missing" : "ambiguous",
    };
  }
  return ready.length === 1
    ? { kind: "use", spec: ready[0] }
    : { kind: "pick", reason: "ambiguous" };
}

/** The pip command that makes an environment usable as a kernel. */
export function installCommand(python: string): string {
  const quoted = /[\s"']/.test(python)
    ? `"${python.replace(/"/g, '\\"')}"`
    : python;
  return `${quoted} -m pip install ipykernel`;
}
