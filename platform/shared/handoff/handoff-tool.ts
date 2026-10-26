import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolSpec } from "../../pi-adapter/index.ts";
import { errorText } from "../text/format.ts";
import type { HandoffToolRows, HandoffValidation } from "./handoff-document.ts";

const HANDOFF_TOOL = "handoff";

export type HandoffTarget = { path: string; requested: boolean };

export type HandoffToolDeps = {
  target: () => HandoffTarget | undefined;
  validate: (text: string) => HandoffValidation;
  rows: HandoffToolRows;
  onSaved?: (text: string, validation: HandoffValidation) => void;
};

type HandoffParams = { content: string };

const handoffParameters = {
  type: "object",
  properties: {
    content: { type: "string", description: "The handoff text, with the sections the instruction lists." },
  },
  required: ["content"],
  additionalProperties: false,
};

export const handoffTool = (deps: HandoffToolDeps): ToolSpec<HandoffParams, unknown> => ({
  name: HANDOFF_TOOL,
  label: "Handoff",
  description:
    "Saves your handoff when you are asked to write one. Pass the whole handoff with the sections the instruction lists; nothing else.",
  promptSnippet: "save your handoff when you are asked to write one",
  parameters: handoffParameters,
  execute: async (params) => {
    const target = deps.target();

    if (!target?.requested) {
      return { text: "Error: no handoff was requested; continue your task.", isError: true };
    }

    const content = (params.content ?? "").trim();

    try {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, `${content}\n`);
    } catch (error) {
      return { text: `Error: handoff not saved at ${target.path}: ${errorText(error)}`, isError: true };
    }

    const validation = deps.validate(content);

    deps.onSaved?.(content, validation);

    if (!validation.ok) {
      return {
        text: `Handoff saved at ${target.path} but it is invalid: ${validation.errors.join("; ")}. Fix the sections and call handoff again.`,
        isError: true,
      };
    }

    return { text: `Handoff saved at ${target.path}` };
  },
  renderShell: "row",
  ...deps.rows,
});
