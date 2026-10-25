import { createPiRuntime } from "../../../../platform/pi-adapter/child/child-runtime.ts";
import type { SkillFile } from "../../../../platform/pi-adapter/child/skills.ts";
import type { AgentRuntime } from "../../../../platform/pi-adapter/index.ts";
import { liveModel } from "./live-model.ts";

export const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

export type LiveSkillFile = Omit<SkillFile, "scope"> & Partial<Pick<SkillFile, "scope">>;

export type LiveParent = { trusted?: boolean; skillFiles?: LiveSkillFile[] };

export const createLiveAgentRuntime = (
  options: { namespace: string; exclude: string[] },
  parent: LiveParent = {},
): AgentRuntime => {
  const { model, registry, provider, thinking } = liveModel();
  const skillFiles = (parent.skillFiles ?? []).map((file) => ({ scope: "user" as const, ...file }));

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
      inventorySkillFiles: () => skillFiles,
      sessionSkillFiles: () => skillFiles,
      activeTools: () => PI_DEFAULT_TOOLS.map((name) => ({ name, path: `builtin:${name}` })),
      mcpDisabled: () => false,
    },
    options,
  );
};
