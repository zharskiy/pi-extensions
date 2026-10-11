import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "../../manager/plugin.ts";
import type { AgentDefinitions } from "../../manager/types.ts";
import { type DefinitionDir, type LoadResult, loadDefinitions } from "./loader.ts";
import { assemblePromptAppend } from "./prompt.ts";

export const BASE_PROMPT_FILE = join("prompts", "base-system-prompt.md");

export const MAIN_SESSION_PROMPT_FILE = join("prompts", "main-session.md");

export const agentDefinitionsPlugin: Plugin = {
  id: "agent-definitions",
  enable: ({ host, services, packageRoot }) => {
    const basePrompt = readFileSync(join(packageRoot, BASE_PROMPT_FILE), "utf8");
    const mainPrompt = readFileSync(join(packageRoot, MAIN_SESSION_PROMPT_FILE), "utf8").trim();

    let loaded: LoadResult = { definitions: new Map(), errors: [] };

    const list = () =>
      Array.from(loaded.definitions.values()).sort((left, right) => left.name.localeCompare(right.name));

    const reload = () => {
      const info = host.session();
      const dirs: DefinitionDir[] = [{ path: join(packageRoot, "agents"), source: "builtin" }];

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
      errors: () => loaded.errors,
      reload,
      mainPrompt: () => mainPrompt,
      promptAppend: (definition) => assemblePromptAppend(basePrompt, definition),
    };

    services.provide("definitions", definitions);
    host.setMainPrompt(mainPrompt);
    reload();

    host.onSessionStart(() => {
      reload();

      loaded.errors.forEach((error) => {
        host.ui.notify(`pi-subagents: invalid agent file ${error.path}: ${error.message}`, "warning");
      });
    });

    return undefined;
  },
};
