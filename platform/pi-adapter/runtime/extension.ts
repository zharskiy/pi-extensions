import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createPiRuntime } from "../child/child-runtime.ts";
import { createSkillInventory } from "../child/skills.ts";
import type { Host } from "../types/host-capabilities.ts";
import type { SkillInfo } from "../types/messages.ts";
import type { AgentRuntime } from "../types/runtime.ts";
import type { HostState } from "../ui/tui-context.ts";
import { insideChildSession } from "./child-scope.ts";
import { createPiHost, liveCtx } from "./host.ts";

export const mcpBuiltinLoaded = (pi: Pick<ExtensionAPI, "getCommands">) =>
  pi.getCommands().some((command) => command.sourceInfo.path === "builtin:mcp");

export const sessionSkillFiles = (pi: Pick<ExtensionAPI, "getCommands">): SkillInfo[] =>
  pi
    .getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => ({
      name: command.name.replace(/^skill:/, ""),
      description: command.description ?? "",
      scope: command.sourceInfo.scope,
      path: command.sourceInfo.path,
    }));

const parentTools = (pi: ExtensionAPI) => {
  const active = new Set(pi.getActiveTools());

  return pi
    .getAllTools()
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({ name: tool.name, path: tool.sourceInfo.path }));
};

export const createPiExtension =
  (
    boot: (host: Host, runtime: AgentRuntime, paths: { root: string; agentDir: string }) => void,
    options: { root: string; namespace: string; childExclude?: readonly string[]; skillInventory?: boolean },
  ): ExtensionFactory =>
  (pi) => {
    if (insideChildSession()) {
      return;
    }

    const inventory = createSkillInventory(() => sessionSkillFiles(pi));

    if (options.skillInventory) {
      pi.on("session_start", (_event, ctx) =>
        inventory.scan({ cwd: ctx.cwd, agentDir: getAgentDir(), projectTrusted: ctx.isProjectTrusted() }),
      );
    }

    const state: HostState = { tools: new Map() };
    const host = createPiHost(pi, state);

    const runtime = createPiRuntime(
      {
        ctx: () => liveCtx(state),
        settings: () => pi.getSettings(),
        thinking: () => pi.getThinkingLevel(),
        inventorySkillFiles: inventory.files,
        sessionSkillFiles: () => sessionSkillFiles(pi),
        activeTools: () => parentTools(pi),
        mcpDisabled: () => !mcpBuiltinLoaded(pi),
      },
      { namespace: options.namespace, exclude: options.childExclude ?? [] },
    );

    boot(host, runtime, { root: options.root, agentDir: getAgentDir() });
  };
