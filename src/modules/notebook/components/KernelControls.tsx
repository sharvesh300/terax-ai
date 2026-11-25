import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import type { KernelPicker } from "../kernel/useKernel";
import { installCommand, type KernelSpecInfo } from "../lib/chooseKernel";
import type { InputRequest } from "../lib/kernelRun";

const REASON: Record<NonNullable<KernelPicker["reason"]>, string> = {
  none: "No kernels were found. Install ipykernel in a Python environment to run this notebook.",
  missing:
    "The kernel this notebook was saved with is not installed here. Pick another:",
  ambiguous: "Pick the kernel to run this notebook with:",
};

/** The kernel list, as Jupyter's "Select kernel" dialog. */
export function KernelPickerPanel({
  picker,
  current,
  onSelect,
  onRefresh,
  onClose,
}: {
  picker: KernelPicker;
  current: KernelSpecInfo | null;
  onSelect: (spec: KernelSpecInfo) => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("pointerdown", onDown, { capture: true });
    };
  }, [onClose]);

  const specs = picker.specs ?? [];
  const installed = specs.filter((s) => s.source === "kernelspec");
  const environments = specs.filter((s) => s.source === "environment");

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Select a kernel"
      className="absolute top-12 right-40 z-30 flex max-h-[70%] w-[26rem] flex-col overflow-hidden rounded-lg border border-border/60 bg-popover text-[12px] shadow-lg"
    >
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="font-medium text-foreground">Select a kernel</span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={picker.loading}
          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {picker.loading ? "Searching…" : "Refresh"}
        </button>
      </div>
      <div className="overflow-y-auto p-1.5">
        {picker.reason && (
          <p className="px-2 py-1.5 text-muted-foreground">
            {REASON[picker.reason]}
          </p>
        )}
        {picker.specs === null && (
          <p className="px-2 py-1.5 text-muted-foreground">
            Looking for kernels…
          </p>
        )}
        {installed.length > 0 && (
          <Group title="Jupyter kernels">
            {installed.map((s) => (
              <SpecRow
                key={s.id}
                spec={s}
                current={current}
                onSelect={onSelect}
              />
            ))}
          </Group>
        )}
        {environments.length > 0 && (
          <Group title="Python environments">
            {environments.map((s) => (
              <SpecRow
                key={s.id}
                spec={s}
                current={current}
                onSelect={onSelect}
              />
            ))}
          </Group>
        )}
        {picker.specs !== null && specs.length === 0 && (
          <p className="px-2 py-1.5 text-muted-foreground">
            Nothing found. Create a virtual environment in the workspace (
            <code>python3 -m venv .venv</code>), install ipykernel in it, then
            Refresh.
          </p>
        )}
      </div>
    </div>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <p className="px-2 pt-1.5 pb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </p>
      {children}
    </div>
  );
}

function SpecRow({
  spec,
  current,
  onSelect,
}: {
  spec: KernelSpecInfo;
  current: KernelSpecInfo | null;
  onSelect: (spec: KernelSpecInfo) => void;
}) {
  const [copied, setCopied] = useState(false);
  const active = current?.id === spec.id;
  if (!spec.ready) {
    const command = installCommand(spec.python ?? spec.path);
    return (
      <div className="rounded-md px-2 py-1.5 opacity-80">
        <div className="truncate text-foreground">{spec.displayName}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Needs ipykernel:</span>
          <code className="min-w-0 flex-1 truncate font-mono">{command}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(command).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="shrink-0 rounded border border-border/60 px-1.5 hover:bg-accent"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onSelect(spec)}
      className={cn(
        "block w-full rounded-md px-2 py-1.5 text-left hover:bg-accent",
        active && "bg-accent/60",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="truncate text-foreground">{spec.displayName}</span>
        {active && (
          <span className="text-[10.5px] text-muted-foreground">current</span>
        )}
      </div>
      <div className="truncate font-mono text-[10.5px] text-muted-foreground">
        {spec.path}
      </div>
    </button>
  );
}

/** Answers a kernel's `input()` (or `getpass()`), inline under the cell. */
export function InputPrompt({
  request,
  onSubmit,
}: {
  request: InputRequest;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <form
      className="mt-1 ml-[5rem] flex items-center gap-2 font-mono text-[12px]"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <label className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 whitespace-pre text-muted-foreground">
          {request.prompt || "Input:"}
        </span>
        <input
          ref={ref}
          type={request.password ? "password" : "text"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded border border-ring/60 bg-card px-2 py-1 text-foreground outline-none"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
    </form>
  );
}
