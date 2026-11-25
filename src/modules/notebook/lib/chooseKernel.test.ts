import { describe, expect, it } from "vitest";
import {
  chooseKernel,
  installCommand,
  type KernelSpecInfo,
} from "./chooseKernel";

const spec = (over: Partial<KernelSpecInfo>): KernelSpecInfo => ({
  id: over.id ?? `id:${over.name}`,
  name: "python3",
  displayName: "Python 3",
  language: "python",
  source: "kernelspec",
  path: "/k",
  ready: true,
  ...over,
});

const py3 = spec({ id: "k:py3", name: "python3" });
const ir = spec({ id: "k:ir", name: "ir", language: "R" });
const venv = spec({ id: "env:venv", name: "python3", source: "environment" });
const broken = spec({ id: "env:sys", source: "environment", ready: false });
const meta = (name: string, language = "python") => ({
  kernelspec: { name, display_name: name, language },
});

describe("chooseKernel", () => {
  it("starts the installed kernel the notebook names", () => {
    expect(chooseKernel([py3, venv, ir], meta("python3"), null)).toEqual({
      kind: "use",
      spec: py3,
    });
    expect(chooseKernel([py3, ir], meta("ir", "R"), null)).toEqual({
      kind: "use",
      spec: ir,
    });
  });

  it("prefers the kernel picked for this notebook before", () => {
    expect(chooseKernel([py3, venv], meta("python3"), "env:venv")).toEqual({
      kind: "use",
      spec: venv,
    });
    // A remembered kernel that is gone or not ready is skipped.
    expect(chooseKernel([py3], meta("python3"), "env:venv").kind).toBe("use");
  });

  it("uses the only kernel of the notebook's language when its own is missing", () => {
    expect(chooseKernel([venv, ir], meta("conda-env-ml"), null)).toEqual({
      kind: "use",
      spec: venv,
    });
  });

  it("asks when it cannot tell, as Jupyter does", () => {
    const other = spec({ id: "env:other", source: "environment" });
    expect(chooseKernel([venv, other], meta("conda-env-ml"), null)).toEqual({
      kind: "pick",
      reason: "ambiguous",
    });
    expect(chooseKernel([ir], meta("julia-1.10", "julia"), null)).toEqual({
      kind: "pick",
      reason: "missing",
    });
    expect(chooseKernel([broken], meta("python3"), null)).toEqual({
      kind: "pick",
      reason: "none",
    });
    expect(chooseKernel([], {}, null)).toEqual({
      kind: "pick",
      reason: "none",
    });
  });

  it("picks the only kernel for a notebook that names none", () => {
    expect(chooseKernel([venv], {}, null)).toEqual({ kind: "use", spec: venv });
    expect(chooseKernel([venv, ir], {}, null)).toEqual({
      kind: "pick",
      reason: "ambiguous",
    });
  });
});

describe("installCommand", () => {
  it("quotes interpreters with spaces", () => {
    expect(installCommand("/w/.venv/bin/python")).toBe(
      "/w/.venv/bin/python -m pip install ipykernel",
    );
    expect(installCommand("C:\\Program Files\\Python\\python.exe")).toBe(
      '"C:\\Program Files\\Python\\python.exe" -m pip install ipykernel',
    );
  });
});
