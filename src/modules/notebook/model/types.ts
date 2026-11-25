import type { JsonFormat, JsonObject, JsonValue } from "./json";

export type CellType = "code" | "markdown" | "raw";

/**
 * A MIME bundle with multiline strings joined. JSON MIME types
 * (`application/json`, `*+json`) keep their parsed value.
 */
export type MimeBundle = { readonly [mime: string]: JsonValue };

export type StreamOutput = {
  readonly outputType: "stream";
  readonly name: string;
  readonly text: string;
  readonly extra: JsonObject;
};

export type DisplayDataOutput = {
  readonly outputType: "display_data";
  readonly data: MimeBundle;
  readonly metadata: JsonObject;
  /** From `transient.display_id` at run time; never saved. */
  readonly displayId: string | null;
  readonly extra: JsonObject;
};

export type ExecuteResultOutput = {
  readonly outputType: "execute_result";
  readonly executionCount: number | null;
  readonly data: MimeBundle;
  readonly metadata: JsonObject;
  readonly displayId: string | null;
  readonly extra: JsonObject;
};

export type ErrorOutput = {
  readonly outputType: "error";
  readonly ename: string;
  readonly evalue: string;
  readonly traceback: readonly string[];
  readonly extra: JsonObject;
};

/** An output type this version does not know; written back unchanged. */
export type UnknownOutput = {
  readonly outputType: "unknown";
  readonly raw: JsonObject;
};

export type NotebookOutput =
  | StreamOutput
  | DisplayDataOutput
  | ExecuteResultOutput
  | ErrorOutput
  | UnknownOutput;

export type NotebookCell = {
  /** In-memory identity for rendering and edits; never saved. */
  readonly key: string;
  /** nbformat 4.5 cell id, `null` when the file has none. */
  readonly id: string | null;
  readonly cellType: CellType;
  readonly source: string;
  readonly metadata: JsonObject;
  /** Markdown and raw cells only. */
  readonly attachments: JsonObject | null;
  /** Code cells only (empty otherwise). */
  readonly outputs: readonly NotebookOutput[];
  /** Code cells only. */
  readonly executionCount: number | null;
  /** Members this version does not know; written back unchanged. */
  readonly extra: JsonObject;
};

export type NotebookFormat = JsonFormat & {
  /** What followed the closing brace (Jupyter writes "\n"). */
  readonly trailingNewline: "" | "\n" | "\r\n";
  readonly bom: boolean;
};

export type NotebookDocument = {
  readonly nbformat: 4;
  readonly nbformatMinor: number;
  readonly metadata: JsonObject;
  readonly cells: readonly NotebookCell[];
  readonly extra: JsonObject;
  readonly format: NotebookFormat;
  /**
   * The file held bare NaN/Infinity, read as null. Untouched values keep the
   * original text on save; values in edited parts are written as null.
   */
  readonly hadNonStandardNumbers: boolean;
};

export type NotebookParseError =
  | { readonly kind: "invalid-json"; readonly message: string }
  | { readonly kind: "not-notebook"; readonly message: string }
  | {
      readonly kind: "unsupported-version";
      readonly message: string;
      readonly nbformat: number;
      readonly nbformatMinor: number;
    };

export type NotebookParseResult =
  | { readonly ok: true; readonly doc: NotebookDocument }
  | { readonly ok: false; readonly error: NotebookParseError };
