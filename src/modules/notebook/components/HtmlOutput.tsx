import { MarkdownLink } from "@/modules/markdown/MarkdownLink";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { memo, useMemo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { hasScripts, sanitizeOutputHtml } from "../lib/html";

const components = { a: MarkdownLink };

/** A sanitized HTML output; tables get the app's own styling. */
export const HtmlOutput = memo(function HtmlOutput({ html }: { html: string }) {
  const content = useMemo(
    () =>
      toJsxRuntime(sanitizeOutputHtml(html), {
        Fragment,
        jsx,
        jsxs,
        components,
      }),
    [html],
  );
  return (
    <div>
      <div className="terax-nb-html select-text overflow-x-auto py-1 text-[12.5px]">
        {content}
      </div>
      {hasScripts(html) && (
        <p className="px-1 text-[11px] text-muted-foreground italic">
          This output uses scripts, which are not run here.
        </p>
      )}
    </div>
  );
});
