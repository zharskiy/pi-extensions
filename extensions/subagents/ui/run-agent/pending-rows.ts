import { failureSuffix, row, type TitleParts } from "../../../../platform/ui-kit/index.ts";
import type { AgentRegistry } from "../../core/model/agent-record.ts";
import type {
  MessageAgentParams,
  RunAgentParams,
  StopAgentParams,
  ToolRows,
} from "../../core/run-agent/tools.ts";
import { type BlockHints, renderBlock } from "./render.ts";

type RowDeps = {
  registry: Pick<AgentRegistry, "get" | "batch">;
  hints: BlockHints;
  onRendered?: (batchId: string, invalidate: () => void) => void;
};

type RowTheme = Parameters<ToolRows["messageAgent"]>[2];

const errorRow = (tool: string, target: string, error: string, theme: RowTheme) => {
  const parts: TitleParts = {
    mark: "error",
    verb: (paint) => paint.bold(tool),
    target: { text: target },
  };

  return (width: number) => {
    const suffix = failureSuffix(error, parts, width, theme);
    const spec = suffix
      ? { mark: parts.mark, title: { ...parts, reason: { text: suffix } } }
      : { mark: parts.mark, title: parts, children: [theme.fg("error", error)] };

    return row(spec)(width, theme).join("\n");
  };
};

export const pendingRows = (deps: RowDeps): ToolRows => ({
  runAgent: (result, state, theme) => {
    if (result.details?.batchId) {
      deps.onRendered?.(result.details.batchId, state.invalidate);
    }

    return renderBlock({
      params: state.args as RunAgentParams | undefined,
      result,
      state,
      registry: deps.registry,
      theme,
      hints: deps.hints,
    });
  },
  messageAgent: (result, state, theme) => {
    if (!result.isError) {
      return "";
    }

    const id = String((state.args as MessageAgentParams | undefined)?.id ?? "");

    return errorRow("message_agent", id, result.text.replace(/^Error:\s*/, "").trim(), theme);
  },
  stopAgent: (result, state, theme) => {
    if (!result.isError) {
      return "";
    }

    const ids = (state.args as StopAgentParams | undefined)?.ids ?? [];
    const skipped = result.details?.skipped ?? [];
    const error = skipped.map((entry) => `${entry.id}: ${entry.reason}`).join("; ") || result.text;

    return errorRow("stop_agent", ids.join(", "), error, theme);
  },
});
