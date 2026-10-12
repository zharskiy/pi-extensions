import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "../../model/plugin.ts";
import type { AgentDefinitions } from "../../model/types.ts";
import { type DefinitionDir, type LoadResult, loadDefinitions } from "./loader.ts";
import { assemblePromptAppend } from "./prompt.ts";

const BASE_PROMPT_FILE = join("prompts", "base-system-prompt.md");

export const agentDefinitionsPlugin: Plugin = {
  id: "agent-definitions",
  enable: ({ host, services, root }) => {
    const basePrompt = readFileSync(join(root, BASE_PROMPT_FILE), "utf8");

    let loaded: LoadResult = { definitions: new Map(), errors: [], warnings: [] };

    const list = () =>
      Array.from(loaded.definitions.values()).sort((left, right) => left.name.localeCompare(right.name));

    const reload = () => {
      const info = host.session();
      const dirs: DefinitionDir[] = [{ path: join(root, "agents"), source: "builtin" }];

      if (info) {
        dirs.push({ path: join(info.agentDir, "agents"), source: "user" });
      }

      if (info?.projectTrusted) {
        dirs.push({ path: join(info.cwd, ".pi", "agents"), source: "project" });
      }

      loaded = loadDefinitions(dirs);
    };

    const definitions: AgentDefinitions = {
      get: (name) => loaded.definitions.get(name),
      list,
      reload,
      promptAppend: (definition) => assemblePromptAppend(basePrompt, definition),
    };

    services.provide("definitions", definitions);
    reload();

    host.onSessionStart(() => {
      reload();

      loaded.errors.forEach((error) => {
        host.ui.notify(`pi-subagents: invalid agent file ${error.path}: ${error.message}`, "warning");
      });

      loaded.warnings.forEach((warning) => {
        host.ui.notify(`pi-subagents: agent file ${warning.path}: ${warning.message}`, "warning");
      });
    });

    return undefined;
  },
};
