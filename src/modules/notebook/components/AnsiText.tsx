import { memo, useMemo } from "react";
import { ansiCss, parseAnsi } from "../lib/ansi";

/** Terminal output with its colours, in the terminal theme's palette. */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const segments = useMemo(() => parseAnsi(text), [text]);
  return (
    <>
      {segments.map((s, i) =>
        s.style ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional.
          <span key={i} style={ansiCss(s.style)}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </>
  );
});
