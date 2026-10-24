import { failureSuffix, row, type TitleParts } from "../../../../ui-kit/index.ts";
import type { AgentRegistry } from "../../core/model/types.ts";
import type { MessageAgentParams, RunAgentParams, ToolRows } from "../../core/run-agent/tools.ts";
import { type BlockHints, renderBlock } from "./render.ts";

type RowDeps = {
  registry: Pick<AgentRegistry, "get" | "batch">;
  hints: BlockHints;
  onRendered?: (batchId: string, invalidate: () => void) => void;
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
    const error = result.text.replace(/^Error:\s*/, "").trim();
    const parts: TitleParts = {
      mark: "error",
      verb: (paint) => paint.bold("message_agent"),
      target: { text: id },
    };

    return (width: number) => {
      const suffix = failureSuffix(error, parts, width, theme);
      const spec = suffix
        ? { mark: parts.mark, title: { ...parts, reason: { text: suffix } } }
        : { mark: parts.mark, title: parts, children: [theme.fg("error", error)] };

      return row(spec)(width, theme).join("\n");
    };
  },
});
