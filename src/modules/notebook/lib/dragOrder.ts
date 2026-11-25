// Pure geometry for dragging cells into a new order.

export type VerticalSpan = { readonly top: number; readonly bottom: number };

/**
 * The gap a pointer at `y` drops into: 0 is above the first cell, n below
 * the last. A cell's upper half drops above it, its lower half below.
 */
export function gapAtY(spans: readonly VerticalSpan[], y: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (y < (spans[i].top + spans[i].bottom) / 2) return i;
  }
  return spans.length;
}

/**
 * The index to `move` a cell from `from` to, for a drop into `gap`; null
 * when the drop lands where the cell already is (the gaps either side).
 */
export function moveTarget(from: number, gap: number): number | null {
  if (gap === from || gap === from + 1) return null;
  return gap > from ? gap - 1 : gap;
}

/** Pixels per frame to scroll while dragging near an edge; 0 elsewhere. */
export function edgeScrollSpeed(
  y: number,
  top: number,
  bottom: number,
  zone = 48,
  max = 18,
): number {
  if (bottom - top <= zone * 2) return 0;
  if (y < top + zone)
    return -Math.ceil(max * Math.min(1, (top + zone - y) / zone));
  if (y > bottom - zone)
    return Math.ceil(max * Math.min(1, (y - (bottom - zone)) / zone));
  return 0;
}
