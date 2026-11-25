import { cn } from "@/lib/utils";
import { useMemo, useState } from "react";
import {
  clipLines,
  errorText,
  imageSrc,
  pickDisplayMime,
  terminalText,
} from "../lib/display";
import type { NotebookOutput } from "../model";

/** Long text outputs show this many lines until expanded. */
const MAX_LINES = 400;

export function NotebookOutputView({ output }: { output: NotebookOutput }) {
  switch (output.outputType) {
    case "stream":
      return (
        <TextOutput
          text={terminalText(output.text)}
          tone={output.name === "stderr" ? "stderr" : undefined}
        />
      );
    case "error":
      return <TextOutput text={errorText(output)} tone="error" />;
    case "display_data":
    case "execute_result": {
      const mime = pickDisplayMime(output.data);
      if (mime === null) {
        return (
          <Unsupported
            what={Object.keys(output.data).join(", ") || "Empty output"}
          />
        );
      }
      const value = output.data[mime];
      if (mime === "text/plain") {
        return <TextOutput text={terminalText(value as string)} />;
      }
      const src = imageSrc(mime, value);
      if (!src) return <Unsupported what={`Invalid ${mime} data`} />;
      return (
        <img
          src={src}
          alt=""
          decoding="async"
          loading="lazy"
          className="my-1 block h-auto max-w-full"
        />
      );
    }
    case "unknown":
      return <Unsupported what="An output type this version does not know" />;
  }
}

function TextOutput({
  text,
  tone,
}: {
  text: string;
  tone?: "stderr" | "error";
}) {
  const [expanded, setExpanded] = useState(false);
  const clipped = useMemo(() => clipLines(text, MAX_LINES), [text]);
  const shown = expanded ? text : clipped.text;
  if (text === "") return null;
  return (
    <div
      className={cn(
        "rounded-md",
        tone === "stderr" && "bg-destructive/5",
        tone === "error" && "bg-destructive/10",
      )}
    >
      <pre
        className={cn(
          "select-text overflow-x-auto px-3 py-1.5 font-mono text-[12px] leading-[1.5] whitespace-pre",
          tone === "error" && "text-destructive",
        )}
      >
        {shown}
      </pre>
      {!expanded && clipped.hiddenLines > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mx-3 mb-1.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Show {clipped.hiddenLines.toLocaleString()} more{" "}
          {clipped.hiddenLines === 1 ? "line" : "lines"}
        </button>
      )}
    </div>
  );
}

function Unsupported({ what }: { what: string }) {
  return (
    <p className="px-3 py-1 text-[11px] text-muted-foreground italic">
      {what} — not shown in this view yet.
    </p>
  );
}
