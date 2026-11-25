import { cn } from "@/lib/utils";
import type { MarkdownTab, Tab } from "@/modules/tabs";
import { workspaceRootOf } from "./lib/workspaceRoot";
import { MarkdownPreviewPane } from "./MarkdownPreviewPane";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSetDocumentView: (id: number, mode: "rendered" | "raw") => void;
};

export function MarkdownStack({ tabs, activeId, onSetDocumentView }: Props) {
  const markdowns = tabs.filter(
    (t): t is MarkdownTab => t.kind === "markdown" && !t.cold,
  );
  if (markdowns.length === 0) return null;
  const workspaceRoot = workspaceRootOf(tabs, activeId);
  return (
    <div className="relative h-full w-full">
      {markdowns.map((t) => {
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
            <MarkdownPreviewPane
              path={t.path}
              workspaceRoot={workspaceRoot}
              visible={visible}
              onSetView={(mode) => onSetDocumentView(t.id, mode)}
            />
          </div>
        );
      })}
    </div>
  );
}
