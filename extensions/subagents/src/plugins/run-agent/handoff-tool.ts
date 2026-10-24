import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ToolSpec } from "../../../../../core/adapter/contract.ts";
import { homeRelative } from "../../../../../core/manager/format.ts";
import { markOf } from "../../../../../core/manager/marks.ts";
import { row, rowChildren, rowText } from "../../../../../core/manager/row.ts";
import { errorText } from "../../components/format.ts";
import type { AgentRegistry, HandoffService } from "../../model/types.ts";

type HandoffParams = { content: string };

type HandoffToolDeps = {
  registry: AgentRegistry;
  handoff: HandoffService;
};

const handoffParameters = {
  type: "object",
  properties: {
    content: { type: "string", description: "The handoff text, with the sections the instruction lists." },
  },
  required: ["content"],
  additionalProperties: false,
};

export const handoffTool = (deps: HandoffToolDeps, agentId: string): ToolSpec<HandoffParams, unknown> => ({
  name: "handoff",
  label: "Handoff",
  description:
    "Saves your handoff when you are told your context limit is reached. Pass the handoff text with the sections the instruction lists; nothing else.",
  promptSnippet: "save your handoff when told your context limit is reached",
  parameters: handoffParameters,
  execute: async (params) => {
    const record = deps.registry.get(agentId);

    if (!record?.handoffRequested) {
      return { text: "Error: no handoff was requested; continue your task.", isError: true };
    }

    const content = (params.content ?? "").trim();

    try {
      mkdirSync(dirname(record.handoffPath), { recursive: true });
      writeFileSync(record.handoffPath, `${content}\n`);
    } catch (error) {
      return {
        text: `Error: handoff not saved at ${record.handoffPath}: ${errorText(error)}`,
        isError: true,
      };
    }

    const validation = deps.handoff.validate(content);

    if (!validation.ok) {
      return {
        text: `Handoff saved at ${record.handoffPath} but it is invalid: ${validation.errors.join("; ")}. Fix the sections and call handoff again.`,
        isError: true,
      };
    }

    return { text: `Handoff saved at ${record.handoffPath}` };
  },
  renderShell: "row",
  renderCall: (_params, theme, state) =>
    rowText(row({ mark: markOf(state), title: { verb: (paint) => paint.bold("handoff") } }), theme),
  renderResult: (result, _state, theme) => {
    if (result.isError) {
      const lines = result.text.split("\n");

      return rowText(rowChildren({ children: lines.map((line) => theme.fg("error", line)) }), theme);
    }

    const path = deps.registry.get(agentId)?.handoffPath;
    const saved = path ? `Saved ${homeRelative(path, homedir())}` : result.text;

    return rowText(rowChildren({ children: [theme.fg("muted", saved)] }), theme);
  },
});
