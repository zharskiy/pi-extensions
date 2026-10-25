import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolSpec } from "../../../../platform/pi-adapter/index.ts";
import { errorText, type HandoffToolRows } from "../../../../platform/shared/index.ts";
import type { AgentRegistry, HandoffService } from "../model/agent-record.ts";

type HandoffParams = { content: string };

type HandoffToolDeps = {
  registry: AgentRegistry;
  handoff: HandoffService;
  rows: (savedPath: () => string | undefined) => HandoffToolRows;
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
  ...deps.rows(() => deps.registry.get(agentId)?.handoffPath),
});
