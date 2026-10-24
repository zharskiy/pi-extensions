import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo } from "../../../../pi-adapter/index.ts";
import { CREATE_USAGE, createAgentCommand } from "../../core/agent-setup/create.ts";
import { parseSetupLine, SETUP_USAGE } from "../../core/agent-setup/line.ts";
import type { Scope, SetupChange } from "../../core/agent-setup/scope.ts";
import { overriddenFields, writeChanges } from "../../core/agent-setup/write.ts";
import { INHERIT_MODEL } from "../../core/model/agent-schema.ts";
import { resolutionProblem } from "../../core/model/model-resolution.ts";
import { NAMESPACE } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { settingsPaths } from "../../core/model/settings.ts";
import type { AgentDefinition } from "../../core/model/types.ts";
import type { SetupContext } from "../../ui/agent-setup/form.ts";
import { setupForm } from "../../ui/agent-setup/setup-overlay.ts";

const shippedFirst = (left: AgentDefinition, right: AgentDefinition) =>
  Number(left.source !== "builtin") - Number(right.source !== "builtin") ||
  left.name.localeCompare(right.name);

const changeSummary = (changes: SetupChange[]) =>
  changes.map((change) => `${change.name} (${Object.keys(change.patch).join(", ")})`).join(", ");

export const agentSetupPlugin: Plugin = {
  id: "agent-setup",
  requires: ["agent-definitions"],
  enable: ({ host, runtime, services, root }) => {
    const definitions = services.require("definitions");
    const createPrompt = readFileSync(join(root, "prompts", "create-agent.md"), "utf8").trim();

    const notify = (message: string, level: "info" | "warning" | "error") =>
      host.ui.notify(`${NAMESPACE}: ${message}`, level);

    const save = (scope: Scope, changes: SetupChange[]) => {
      const info = host.session();
      const paths = settingsPaths(info);

      if (scope === "project" && !info.projectTrusted) {
        notify(`not saved: this project is not trusted, so ${paths.project} is not read`, "error");
        return;
      }

      const failure = writeChanges(paths[scope], changes);

      if (failure) {
        notify(failure, "error");
        return;
      }

      definitions.reload();
      notify(`saved ${changeSummary(changes)} to ${paths[scope]}; agents started from now on use it`, "info");

      const shadowed =
        scope === "user" && info.projectTrusted ? overriddenFields(paths.project, changes) : [];

      if (shadowed.length > 0) {
        notify(`${paths.project} also sets ${shadowed.join(", ")} and wins`, "warning");
      }
    };

    const context = (info: SessionInfo): SetupContext => ({
      agents: definitions
        .list()
        .sort(shippedFirst)
        .map((definition) => ({
          name: definition.name,
          description: definition.description,
          tools: definition.tools,
          mcp: definition.mcp !== false,
          initial: {
            model: definition.model ?? INHERIT_MODEL,
            thinking: definition.thinking,
            skills: definition.skills,
          },
        })),
      models: runtime.availableModels(),
      skills: runtime.skillCatalog(),
      trusted: info.projectTrusted,
    });

    const runForm = async () => {
      const info = host.session();
      const paths = settingsPaths(info);

      if (info.mode !== "tui") {
        const files = `${paths.project} or ${paths.user}`;
        const advice = `edit "agents" in ${files}, or run ${SETUP_USAGE}`;

        notify(`/agents setup needs the interactive terminal; ${advice}`, "error");
        return;
      }

      const result = await host.ui.showForm(setupForm(context(info), paths));

      if (!result) {
        return;
      }

      if (result.changes.length === 0) {
        notify("nothing changed", "info");
        return;
      }

      save(result.scope, result.changes);
    };

    const runLine = (args: string) => {
      const request = parseSetupLine(args, {
        agents: definitions.list().map((definition) => definition.name),
        skills: runtime.skillNames(),
        defaultScope: host.session().projectTrusted ? "project" : "user",
        resolveModel: (model) => {
          const resolution = runtime.resolveModel(model);

          return resolution.kind === "resolved"
            ? { ref: resolution.model.ref }
            : { error: `model "${model}": ${resolutionProblem(resolution)}` };
        },
      });

      if ("error" in request) {
        notify(request.error, "error");
        return;
      }

      save(request.scope, [request.change]);
    };

    const create = createAgentCommand({ host, template: createPrompt, definitions, runtime });

    services.provide("agentSetup", {
      usage: { setup: SETUP_USAGE, create: CREATE_USAGE },
      create,
      run: async (args) => {
        if (args.trim()) {
          runLine(args);
          return;
        }

        await runForm();
      },
      complete: (prefix) =>
        definitions
          .list()
          .filter((definition) => definition.name.startsWith(prefix))
          .map((definition) => ({ value: definition.name, label: definition.description })),
    });
  },
};
