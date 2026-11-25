import { OrderedObject, RawJson, type WritableJson, writeJson } from "./json";
import { shouldSplitMime, splitLines } from "./lines";
import {
  cellOrigin,
  docOrigin,
  layoutKey,
  rawFor,
  unchangedDocText,
} from "./origin";
import type {
  MimeBundle,
  NotebookCell,
  NotebookDocument,
  NotebookOutput,
} from "./types";

/**
 * Writes a notebook the way Jupyter does (`json.dumps(indent=1,
 * sort_keys=True, ensure_ascii=False)` plus a newline), following the file's
 * own indent, key order and line endings. Values the user did not touch are
 * written back as their original text, so a save only changes what was edited.
 */
export function serializeNotebook(doc: NotebookDocument): string {
  const unchanged = unchangedDocText(doc);
  if (unchanged !== undefined) return unchanged;

  const { format } = doc;
  const layout = layoutKey(format.indent, format.eol);
  const raw = (v: object): RawJson | undefined => {
    const text = rawFor(v, layout);
    return text === undefined ? undefined : new RawJson(text);
  };

  const ordered = (
    keyOrder: readonly string[] | undefined,
    members: Record<string, WritableJson | undefined>,
  ): OrderedObject => {
    const keys = [
      ...(keyOrder ?? []).filter((k) => members[k] !== undefined),
      ...Object.keys(members).filter(
        (k) => members[k] !== undefined && !keyOrder?.includes(k),
      ),
    ];
    return new OrderedObject(
      keys.map((k) => [k, members[k] as WritableJson] as const),
    );
  };

  const bundle = (data: MimeBundle): WritableJson => {
    const out: Record<string, WritableJson> = {};
    for (const mime of Object.keys(data)) {
      const v = data[mime];
      out[mime] =
        typeof v === "string" && shouldSplitMime(mime) ? splitLines(v) : v;
    }
    return out;
  };

  const output = (o: NotebookOutput): WritableJson => {
    const r = raw(o);
    if (r) return r;
    switch (o.outputType) {
      case "stream":
        return {
          ...o.extra,
          name: o.name,
          output_type: "stream",
          text: splitLines(o.text),
        };
      case "display_data":
        return {
          ...o.extra,
          data: bundle(o.data),
          metadata: o.metadata,
          output_type: "display_data",
        };
      case "execute_result":
        return {
          ...o.extra,
          data: bundle(o.data),
          execution_count: o.executionCount,
          metadata: o.metadata,
          output_type: "execute_result",
        };
      case "error":
        return {
          ...o.extra,
          ename: o.ename,
          evalue: o.evalue,
          output_type: "error",
          traceback: o.traceback,
        };
      case "unknown":
        return o.raw;
    }
  };

  const cell = (c: NotebookCell): WritableJson => {
    const r = raw(c);
    if (r) return r;
    const origin = cellOrigin(c);
    const source =
      origin && origin.source === c.source
        ? new RawJson(origin.sourceText)
        : splitLines(c.source);
    const isCode = c.cellType === "code";
    return ordered(origin?.keyOrder, {
      ...c.extra,
      attachments: !isCode && c.attachments ? c.attachments : undefined,
      cell_type: c.cellType,
      execution_count: isCode ? c.executionCount : undefined,
      id: c.id ?? undefined,
      metadata: c.metadata,
      outputs: isCode ? (raw(c.outputs) ?? c.outputs.map(output)) : undefined,
      source,
    });
  };

  const root = ordered(docOrigin(doc)?.keyOrder, {
    ...doc.extra,
    cells: raw(doc.cells) ?? doc.cells.map(cell),
    metadata: doc.metadata,
    nbformat: doc.nbformat,
    nbformat_minor: doc.nbformatMinor,
  });

  const body = writeJson(root, format, (v) => rawFor(v, layout));
  return (format.bom ? "﻿" : "") + body + format.trailingNewline;
}
