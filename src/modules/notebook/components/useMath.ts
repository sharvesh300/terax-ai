import type { MathPlugin } from "@streamdown/math";
import { useEffect, useState } from "react";

let loaded: MathPlugin | null = null;
let pending: Promise<MathPlugin> | null = null;

function loadMath(): Promise<MathPlugin> {
  pending ??= import("./mathRuntime").then(
    (m) => {
      loaded = m.notebookMath;
      return loaded;
    },
    (error: unknown) => {
      // Let a later cell try again instead of caching the failure.
      pending = null;
      throw error;
    },
  );
  return pending;
}

/**
 * The math plugin once loaded, for cells that need it; null until then (the
 * cell shows its source text) and for cells without math.
 */
export function useMath(needed: boolean): MathPlugin | null {
  const [plugin, setPlugin] = useState(loaded);
  useEffect(() => {
    if (!needed || plugin) return;
    let alive = true;
    loadMath()
      .then((m) => {
        if (alive) setPlugin(m);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [needed, plugin]);
  return needed ? plugin : null;
}
