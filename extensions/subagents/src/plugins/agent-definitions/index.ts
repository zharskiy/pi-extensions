import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelChoice, ModelResolution } from "../../../../../core/adapter/contract.ts";
import { NAMESPACE } from "../../model/paths.ts";
import type { Plugin } from "../../model/plugin.ts";
import type { AgentDefinitions } from "../../model/types.ts";
import { type DefinitionDir, loadDefinitions } from "./loader.ts";
import { assemblePromptAppend } from "./prompt.ts";

const refs = (models: ModelChoice[]) => models.map((model) => model.ref).join(", ");

const resolutionProblem = (resolution: Exclude<ModelResolution, { kind: "resolved" }>) => {
  if (resolution.kind === "invalid") {
    return resolution.error;
  }

  if (resolution.kind === "ambiguous") {
    return `matches several models (${refs(resolution.candidates)})`;
  }

  return resolution.withoutCredentials.length > 0
    ? `matches only models without credentials (${refs(resolution.withoutCredentials)})`
    : "matches no available model";
};

export const agentDefinitionsPlugin: Plugin = {
  id: "agent-definitions",
  enable: ({ host, runtime, services, settings, root }) => {
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

    const reported = new Set<string>();

    const modelProblem = (model: string) => {
      const resolution = runtime.resolveModel(model);

      return resolution.kind === "resolved" ? undefined : resolutionProblem(resolution);
    };

    host.onSessionStart((info) => {
      const dirs: DefinitionDir[] = [builtin, { path: join(info.agentDir, "agents"), source: "user" }];
      const projectAgents = join(info.cwd, ".pi", "agents");

      if (info.projectTrusted) {
        dirs.push({ path: projectAgents, source: "project" });
      }

      loaded = loadDefinitions(dirs, {
        overrides: settings.agents,
        skillNames: () => runtime.skillNames(),
        modelProblem,
        untrustedDir: info.projectTrusted ? undefined : projectAgents,
      });

      loaded.errors.forEach((error) => {
        host.ui.notify(`pi-subagents: invalid agent file ${error.path}: ${error.message}`, "warning");
      });

      loaded.warnings.forEach((warning) => {
        host.ui.notify(`pi-subagents: agent file ${warning.path}: ${warning.message}`, "warning");
      });

      loaded.notices
        .filter((notice) => !reported.has(notice.message))
        .forEach((notice) => {
          reported.add(notice.message);
          host.ui.notify(`${NAMESPACE} settings: ${notice.message}`, notice.level);
        });
    });
  },
};
