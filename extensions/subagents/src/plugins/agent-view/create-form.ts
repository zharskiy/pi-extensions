import type { FormFactory, KeyPress, ThemeLike } from "../../../../../core/adapter/contract.ts";
import { hintLines, padded, rule } from "../../../../../core/manager/layout.ts";
import {
  CANCEL_HINT,
  type ListOption,
  listKey,
  listLines,
  SELECT_HINTS,
} from "../../../../../core/manager/list.ts";
import { type AgentKind, INHERIT } from "./agent-template.ts";

export type CreateAnswers = { description: string; kind: AgentKind; model: string };

type Step = "description" | "kind" | "model";

const KINDS: readonly (ListOption & { value: AgentKind })[] = [
  { value: "lead", label: "lead", description: "edits and runs commands, may start scouts, has MCP" },
  { value: "chore", label: "chore", description: "read-only helper, starts no agents, no MCP servers" },
];

const PROMPTS: Record<Step, string> = {
  description: "Description: when to use it, what it is not for, what it returns. Empty for a placeholder.",
  kind: "Kind: sets the tools, subagents and mcp defaults.",
  model: `Model: provider/id or provider/id:thinking. Empty uses ${INHERIT}, the main session's model.`,
};

const HINTS: Record<Step, readonly string[]> = {
  description: ["Enter next", CANCEL_HINT],
  kind: [...SELECT_HINTS, "Enter next", CANCEL_HINT],
  model: ["Enter create", CANCEL_HINT],
};

export const createAgentForm =
  (name: string, target: string): FormFactory<CreateAnswers | undefined> =>
  (api) => {
    const input = api.createTextInput();
    let step: Step = "description";
    let description = "";
    let kind = 0;

    const stepLines = (theme: ThemeLike, width: number) =>
      step === "kind"
        ? listLines(theme, KINDS, kind, width, { layout: "beside" })
        : input.render(Math.max(1, width - 2)).map((line) => ` ${line}`);

    input.onSubmit((text) => {
      if (step === "description") {
        description = text;
        step = "kind";
        input.setText("");
        api.requestRender();
        return;
      }

      api.done({ description, kind: KINDS[kind].value, model: text });
    });

    const pickKind = (key: KeyPress) => {
      const move = listKey(key, kind, KINDS.length);

      if (!move) {
        return;
      }

      kind = move.index;

      if (move.pick) {
        step = "model";
      }

      api.requestRender();
    };

    return {
      render: (width) => [
        rule(api.theme, width),
        ...padded(api.theme, api.theme.fg("text", `New agent ${name} in ${target}`), width),
        "",
        ...padded(api.theme, api.theme.fg("muted", PROMPTS[step]), width),
        ...stepLines(api.theme, width),
        "",
        ...hintLines(api.theme, HINTS[step], width),
        rule(api.theme, width),
      ],
      handleKey: (key) => {
        if (key.name === "escape") {
          api.done(undefined);
          return;
        }

        if (step === "kind") {
          pickKind(key);
          return;
        }

        input.handleKey(key);
        api.requestRender();
      },
    };
  };
