import type { Tab } from "@/modules/tabs";

/** The folder the explorer shows: the active terminal's cwd, else any terminal's. */
export function workspaceRootOf(tabs: Tab[], activeId: number): string | null {
  const active = tabs.find((t) => t.id === activeId);
  if (active?.kind === "terminal" && active.cwd) return active.cwd;
  for (const t of tabs) if (t.kind === "terminal" && t.cwd) return t.cwd;
  return null;
}
