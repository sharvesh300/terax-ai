import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { keepWoff2Only } from "../../../scripts/katex-fonts.mjs";

const require = createRequire(import.meta.url);
const css = readFileSync(require.resolve("katex/dist/katex.min.css"), "utf8");

describe("KaTeX fonts", () => {
  it("ships only woff2, keeping every face", () => {
    const out = keepWoff2Only(css);
    const faces = (s: string) => s.match(/@font-face/g)?.length ?? 0;
    expect(faces(out)).toBe(faces(css));
    expect(faces(out)).toBeGreaterThan(10);
    expect(out).not.toMatch(/\.(?:woff|ttf)\)/);
    expect(out.match(/format\("woff2"\)/g)?.length).toBe(faces(css));
  });
});
