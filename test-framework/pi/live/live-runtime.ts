import { createPiRuntime } from "../../../pi-adapter/child/child-runtime.ts";
import type { SkillFile } from "../../../pi-adapter/child/skills.ts";
import type { AgentRuntime } from "../../../pi-adapter/index.ts";
import { liveModel } from "./live-model.ts";

export const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export type LiveParent = { trusted?: boolean; skillFiles?: SkillFile[] };

export const createLiveAgentRuntime = (
  options: { namespace: string; exclude: string[] },
  parent: LiveParent = {},
): AgentRuntime => {
  const { model, registry, provider, thinking } = liveModel();

  const ctx = {
    model,
    modelRegistry: registry,
    isProjectTrusted: () => parent.trusted === true,
    ui: { theme: {} },
  };

  return createPiRuntime(
    {
      ctx: () => ctx as never,
      settings: () => ({ defaultProvider: provider }) as never,
      thinking: () => thinking ?? "off",
      inventorySkillFiles: () => parent.skillFiles ?? [],
      sessionSkillFiles: () => parent.skillFiles ?? [],
      activeTools: () => PI_DEFAULT_TOOLS.map((name) => ({ name, path: `builtin:${name}` })),
      mcpDisabled: () => false,
    },
    options,
  );
};
