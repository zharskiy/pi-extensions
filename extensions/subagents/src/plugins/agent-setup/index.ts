import { sep } from "node:path";
import type { FormFactory, ModelResolution, SessionInfo } from "../../../../../core/adapter/contract.ts";
import { projectSettingsPath, userSettingsPath } from "../../../../../core/manager/settings.ts";
import { INHERIT_MODEL } from "../../model/agent-schema.ts";
import { NAMESPACE } from "../../model/paths.ts";
import type { Plugin } from "../../model/plugin.ts";
import { loadSettings, SETTINGS_FILE } from "../../model/settings.ts";
import type { AgentDefinition } from "../../model/types.ts";
import {
  initialSetup,
  pressSetupKey,
  SCOPES,
  type Scope,
  type SetupChange,
  type SetupContext,
  setupChanges,
} from "./form.ts";
import { parseSetupLine, SETUP_USAGE } from "./line.ts";
import { renderSetup, type SetupPaths } from "./render.ts";
import { overriddenFields, writeChanges } from "./write.ts";

export type SetupResult = { scope: Scope; changes: SetupChange[] };

const groupOf = (definition: AgentDefinition) => {
  if (definition.source !== "builtin") {
    return 2;
  }

  return definition.path.includes(`${sep}chores${sep}`) ? 1 : 0;
};

const byGroup = (left: AgentDefinition, right: AgentDefinition) =>
  groupOf(left) - groupOf(right) || left.name.localeCompare(right.name);

const pathsOf = (info: SessionInfo): SetupPaths => ({
  project: projectSettingsPath(info.cwd, SETTINGS_FILE),
  user: userSettingsPath(info.agentDir, SETTINGS_FILE),
});

const modelError = (request: string, resolution: Exclude<ModelResolution, { kind: "resolved" }>) => {
  if (resolution.kind === "invalid") {
    return resolution.error;
  }

  if (resolution.kind === "ambiguous") {
    const refs = resolution.candidates.map((model) => model.ref).join(", ");

    return `model "${request}" matches several models (${refs}); use provider/id`;
  }

  return `model "${request}" matches no model with credentials`;
};

export const setupForm =
  (context: SetupContext, paths: SetupPaths): FormFactory<SetupResult | undefined> =>
  (api) => {
    let state = initialSetup(context);

    return {
      render: (width) => renderSetup(context, state, paths, api.theme, width),
      handleKey: (key) => {
        const outcome = pressSetupKey(context, state, key);

        state = outcome.state;

        if (outcome.done === "cancel") {
          api.done(undefined);
          return;
        }

        if (outcome.done === "save") {
          api.done({ scope: SCOPES[state.scope] ?? "user", changes: setupChanges(context, state) });
          return;
        }

        api.requestRender();
      },
    };
  };

const changeSummary = (changes: SetupChange[]) =>
  changes.map((change) => `${change.name} (${Object.keys(change.patch).join(", ")})`).join(", ");

export const agentSetupPlugin: Plugin = {
  id: "agent-setup",
  requires: ["agent-definitions"],
  enable: ({ host, runtime, services, settings }) => {
    const definitions = services.require("definitions");

    const notify = (message: string, level: "info" | "warning" | "error") =>
      host.ui.notify(`${NAMESPACE}: ${message}`, level);

    const reload = (info: SessionInfo) => {
      const loaded = loadSettings(info.agentDir, info.cwd, info.projectTrusted);

      Object.assign(settings, loaded.settings);
      loaded.errors.forEach((message) => {
        host.ui.notify(`${NAMESPACE} settings: ${message}`, "warning");
      });
      definitions.reload();
    };

    const save = (scope: Scope, changes: SetupChange[]) => {
      const info = host.session();
      const paths = pathsOf(info);

      if (scope === "project" && !info.projectTrusted) {
        notify(`not saved: this project is not trusted, so ${paths.project} is not read`, "error");
        return;
      }

      const failure = writeChanges(paths[scope], changes);

      if (failure) {
        notify(failure, "error");
        return;
      }

      reload(info);
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
        .sort(byGroup)
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
      skills: runtime.skillNames(),
      trusted: info.projectTrusted,
    });

    const runForm = async () => {
      const info = host.session();
      const paths = pathsOf(info);

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
        notify("agent setup: nothing changed", "info");
        return;
      }

      save(result.scope, result.changes);
    };

    const runLine = (args: string) => {
      const request = parseSetupLine(args, {
        agents: definitions.list().map((definition) => definition.name),
        skills: runtime.skillNames(),
        resolveModel: (model) => {
          const resolution = runtime.resolveModel(model);

          return resolution.kind === "resolved"
            ? { ref: resolution.model.ref }
            : { error: modelError(model, resolution) };
        },
      });

      if ("error" in request) {
        notify(request.error, "error");
        return;
      }

      save(request.scope, [request.change]);
    };

    services.provide("agentSetup", {
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
