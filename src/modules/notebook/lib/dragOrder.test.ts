import { describe, expect, it } from "vitest";
import { edgeScrollSpeed, gapAtY, moveTarget } from "./dragOrder";

const spans = [
  { top: 0, bottom: 100 },
  { top: 120, bottom: 160 },
  { top: 180, bottom: 400 },
];

describe("gapAtY", () => {
  it("drops above a cell over its upper half and below it over the lower", () => {
    expect(gapAtY(spans, -20)).toBe(0);
    expect(gapAtY(spans, 49)).toBe(0);
    expect(gapAtY(spans, 51)).toBe(1);
    expect(gapAtY(spans, 110)).toBe(1);
    expect(gapAtY(spans, 141)).toBe(2);
    expect(gapAtY(spans, 300)).toBe(3);
    expect(gapAtY(spans, 9999)).toBe(3);
    expect(gapAtY([], 10)).toBe(0);
  });
});

describe("moveTarget", () => {
  it("maps a drop gap to the move index", () => {
    expect(moveTarget(2, 0)).toBe(0);
    expect(moveTarget(0, 3)).toBe(2);
    expect(moveTarget(0, 2)).toBe(1);
    expect(moveTarget(3, 1)).toBe(1);
  });

  it("ignores drops right where the cell already is", () => {
    expect(moveTarget(1, 1)).toBeNull();
    expect(moveTarget(1, 2)).toBeNull();
  });
});

describe("edgeScrollSpeed", () => {
  it("scrolls faster the closer the pointer is to an edge", () => {
    expect(edgeScrollSpeed(300, 0, 600)).toBe(0);
    expect(edgeScrollSpeed(40, 0, 600)).toBeLessThan(0);
    expect(edgeScrollSpeed(0, 0, 600)).toBe(-18);
    expect(edgeScrollSpeed(-50, 0, 600)).toBe(-18);
    expect(edgeScrollSpeed(560, 0, 600)).toBeGreaterThan(0);
    expect(edgeScrollSpeed(600, 0, 600)).toBe(18);
    expect(Math.abs(edgeScrollSpeed(10, 0, 600))).toBeGreaterThan(
      Math.abs(edgeScrollSpeed(40, 0, 600)),
    );
  });

  it("never scrolls a list too short to have edge zones", () => {
    expect(edgeScrollSpeed(10, 0, 80)).toBe(0);
  });
});
