import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "../../model/plugin.ts";
import type { AgentDefinitions } from "../../model/types.ts";
import { type DefinitionDir, loadDefinitions } from "./loader.ts";
import { assemblePromptAppend } from "./prompt.ts";

export const agentDefinitionsPlugin: Plugin = {
  id: "agent-definitions",
  enable: ({ host, services, root }) => {
    const basePrompt = readFileSync(join(root, "prompts", "base-system-prompt.md"), "utf8");
    const builtin: DefinitionDir = { path: join(root, "agents"), source: "builtin" };

    let loaded = loadDefinitions([builtin]);

    const definitions: AgentDefinitions = {
      get: (name) => loaded.definitions.get(name),
      list: () =>
        Array.from(loaded.definitions.values()).sort((left, right) => left.name.localeCompare(right.name)),
      promptAppend: (definition) => assemblePromptAppend(basePrompt, definition),
    };

    services.provide("definitions", definitions);

    host.onSessionStart((info) => {
      const dirs: DefinitionDir[] = [builtin, { path: join(info.agentDir, "agents"), source: "user" }];

      if (info.projectTrusted) {
        dirs.push({ path: join(info.cwd, ".pi", "agents"), source: "project" });
      }

      loaded = loadDefinitions(dirs);

      loaded.errors.forEach((error) => {
        host.ui.notify(`pi-subagents: invalid agent file ${error.path}: ${error.message}`, "warning");
      });

      loaded.warnings.forEach((warning) => {
        host.ui.notify(`pi-subagents: agent file ${warning.path}: ${warning.message}`, "warning");
      });
    });
  },
};
