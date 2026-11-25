import { cn } from "@/lib/utils";
import { useState } from "react";
import type { JsonValue } from "../model";

/** Children render only when opened, so large JSON costs little. */
export function JsonTree({ value }: { value: JsonValue }) {
  return (
    <div className="select-text overflow-x-auto rounded-md px-3 py-1.5 font-mono text-[12px] leading-[1.6]">
      <JsonNode value={value} depth={0} />
    </div>
  );
}

const MAX_CHILDREN = 500;

function JsonNode({
  label,
  value,
  depth,
}: {
  label?: string;
  value: JsonValue;
  depth: number;
}) {
  const isArray = Array.isArray(value);
  const isContainer = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < 1);
  const [showAll, setShowAll] = useState(false);
  const key = label !== undefined && (
    <span className="text-[var(--tok-property)]">{label}: </span>
  );

  if (!isContainer) {
    return (
      <div>
        {key}
        <JsonScalar value={value} />
      </div>
    );
  }

  const entries: [string, JsonValue][] = isArray
    ? (value as readonly JsonValue[]).map((v, i) => [String(i), v])
    : Object.entries(value);
  const count = entries.length;
  const [openMark, closeMark] = isArray ? ["[", "]"] : ["{", "}"];
  if (count === 0) {
    return (
      <div>
        {key}
        {openMark}
        {closeMark}
      </div>
    );
  }
  const shown = showAll ? entries : entries.slice(0, MAX_CHILDREN);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-left hover:text-foreground"
      >
        <span
          aria-hidden
          className={cn(
            "inline-block w-3 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        >
          ›
        </span>
        {key}
        {openMark}
        {!open && (
          <span className="text-muted-foreground">
            {` ${count} ${isArray ? (count === 1 ? "item" : "items") : count === 1 ? "key" : "keys"} `}
            {closeMark}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="border-l border-border/60 pl-4">
            {shown.map(([k, v]) => (
              <JsonNode key={k} label={k} value={v} depth={depth + 1} />
            ))}
            {shown.length < count && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                Show {(count - shown.length).toLocaleString()} more
              </button>
            )}
          </div>
          <div>{closeMark}</div>
        </>
      )}
    </div>
  );
}

function JsonScalar({ value }: { value: JsonValue }) {
  if (typeof value === "string") {
    return (
      <span className="tok-string break-all">{JSON.stringify(value)}</span>
    );
  }
  if (typeof value === "number")
    return <span className="tok-number">{value}</span>;
  if (typeof value === "boolean")
    return <span className="tok-bool">{String(value)}</span>;
  return <span className="tok-atom">null</span>;
}
