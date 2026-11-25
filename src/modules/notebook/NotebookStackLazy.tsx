import { lazy, Suspense } from "react";
import type { ComponentProps } from "react";
import type { NotebookStack as NotebookStackType } from "@/modules/notebook/NotebookStack";

const NotebookStackInner = lazy(() =>
  import("@/modules/notebook/NotebookStack").then((m) => ({
    default: m.NotebookStack,
  })),
);

type Props = ComponentProps<typeof NotebookStackType>;

export function NotebookStack(props: Props) {
  if (!props.tabs.some((tab) => tab.kind === "notebook" && !tab.cold))
    return null;
  return (
    <Suspense fallback={null}>
      <NotebookStackInner {...props} />
    </Suspense>
  );
}
