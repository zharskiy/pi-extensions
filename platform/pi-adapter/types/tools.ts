import type { ThemeLike } from "./theme.ts";

export type ToolResult<D = unknown> = {
  text: string;
  details?: D;
  isError?: boolean;
};

export type ToolRenderState = {
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
  args: unknown;
  aborted: boolean;
  result?: ToolResult;
  invalidate(): void;
};

export type ToolRender = string | ((width: number) => string);

export type ToolSpec<P = Record<string, unknown>, D = unknown> = {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Record<string, unknown>;
  executionMode?: "sequential" | "parallel";
  modelOnly?: boolean;
  renderShell?: "default" | "row";
  execute(
    params: P,
    ctx: { signal?: AbortSignal; toolCallId?: string; update(text: string, details?: D): void },
  ): Promise<ToolResult<D>>;
  pendingResult?(toolCallId: string, owner: string | undefined): ToolResult<D> | undefined;
  renderCall?(params: P, theme: ThemeLike, state: ToolRenderState): ToolRender;
  renderResult?(result: ToolResult<D>, state: ToolRenderState, theme: ThemeLike): ToolRender;
};

export type AnyToolSpec = ToolSpec<never, unknown>;

export type RowLines = (width: number, theme: ThemeLike) => string[];

export type ToolCallView = {
  name: string;
  args: unknown;
  argsComplete: boolean;
  started: boolean;
  isPartial: boolean;
  isError: boolean;
  expanded: boolean;
  cwd: string;
  durationMs?: number;
  aborted: boolean;
  label?: string;
  result?: ToolResult & { images: number };
};

export type ToolRow = { call: RowLines; result?: RowLines; piBody?: boolean; dropTiming?: boolean };

export type ToolRows = (view: ToolCallView) => ToolRow | undefined;
