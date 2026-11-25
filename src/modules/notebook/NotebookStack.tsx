import { cn } from "@/lib/utils";
import type { NotebookTab, Tab } from "@/modules/tabs";
import { NotebookPane } from "./NotebookPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetDocumentView: (id: number, mode: "rendered" | "raw") => void;
};

export function NotebookStack({ tabs, activeId, onSetDocumentView }: Props) {
  const notebooks = tabs.filter(
    (t): t is NotebookTab => t.kind === "notebook" && !t.cold,
  );
  if (notebooks.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {notebooks.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <NotebookPane
              path={t.path}
              visible={visible}
              onSetView={(mode) => onSetDocumentView(t.id, mode)}
            />
          </div>
        );
      })}
    </div>
  );
}
