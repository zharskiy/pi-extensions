import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionInfo, ToolSpec } from "../../../../platform/pi-adapter/index.ts";
import { AWAITING_INPUT_CHANNEL } from "../../../../platform/shared/index.ts";
import { type SelectOption, selectForm } from "../../../../platform/ui-kit/index.ts";
import {
  AUTOSETUP_TYPE,
  autosetupBrief,
  candidateSkills,
  hasSkillsOverride,
  projectListing,
} from "../../core/agent-setup/autosetup.ts";
import { CREATE_USAGE, createAgentCommand } from "../../core/agent-setup/create.ts";
import { parseSetupLine, SETUP_USAGE } from "../../core/agent-setup/line.ts";
import {
  CANCELLED,
  CONFIRMED_UNCHANGED,
  checkProposal,
  NOT_INTERACTIVE,
  NOT_PENDING,
  NOTHING_TO_CHANGE,
  type Proposal,
  type ProposalParams,
  proposalDefinition,
  proposalUnchanged,
  savedText,
} from "../../core/agent-setup/proposal.ts";
import type { Scope, SetupChange } from "../../core/agent-setup/scope.ts";
import { overriddenFields, writeChanges } from "../../core/agent-setup/write.ts";
import { type AgentDefinition, isLead } from "../../core/model/agent-record.ts";
import { INHERIT_MODEL } from "../../core/model/agent-schema.ts";
import { resolutionProblem } from "../../core/model/model-resolution.ts";
import { NAMESPACE } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { settingsPaths } from "../../core/model/settings.ts";
import type { SetupContext } from "../../ui/agent-setup/form.ts";
import { setupForm } from "../../ui/agent-setup/setup-overlay.ts";

const setupOrder = (left: AgentDefinition, right: AgentDefinition) =>
  Number(!isLead(left)) - Number(!isLead(right)) ||
  Number(left.source !== "builtin") - Number(right.source !== "builtin") ||
  left.name.localeCompare(right.name);

const PROPOSE_TITLE = "Propose skills automatically for this project?";

const PROPOSE_OPTIONS: SelectOption<"yes" | "no">[] = [
  { value: "yes", label: "Yes", description: "the main session proposes skills for the lead agents" },
  { value: "no", label: "No", description: "open the setup form" },
];

type SaveOutcome = { path: string; warning?: string } | { error: string };

const failed = (text: string) => ({ text, isError: true });

const changeSummary = (changes: SetupChange[]) =>
  changes.map((change) => `${change.name} (${Object.keys(change.patch).join(", ")})`).join(", ");

export const agentSetupPlugin: Plugin = {
  id: "agent-setup",
  requires: ["agent-definitions"],
  enable: ({ host, runtime, services, settings, paths }) => {
    const definitions = services.require("definitions");
    const createPrompt = readFileSync(join(paths.root, "prompts", "create-agent.md"), "utf8").trim();
    const autosetupPrompt = readFileSync(join(paths.root, "prompts", "autosetup-skills.md"), "utf8").trim();

    let pending: { candidates: string[]; interactive: string[] } | undefined;

    const notify = (message: string, level: "info" | "warning" | "error") =>
      host.ui.notify(`${NAMESPACE}: ${message}`, level);

    const save = (scope: Scope, changes: SetupChange[], announce = true): SaveOutcome => {
      const info = host.session();
      const paths = settingsPaths(info);

      if (scope === "project" && !info.projectTrusted) {
        const error = `not saved: this project is not trusted, so ${paths.project} is not read`;

        notify(error, "error");
        return { error };
      }

      const failure = writeChanges(info, scope, changes);

      if (failure) {
        notify(failure, "error");
        return { error: failure };
      }

      definitions.reload();

      if (announce) {
        notify(
          `saved ${changeSummary(changes)} to ${paths[scope]}; agents started from now on use it`,
          "info",
        );
      }

      const shadowed =
        scope === "user" && info.projectTrusted ? overriddenFields(paths.project, changes) : [];

      if (shadowed.length === 0) {
        return { path: paths[scope] };
      }

      const warning = `${paths.project} also sets ${shadowed.join(", ")} and wins`;

      notify(warning, "warning");

      return { path: paths[scope], warning };
    };

    const context = (info: SessionInfo, proposal?: Proposal): SetupContext => ({
      agents: definitions
        .list()
        .sort(setupOrder)
        .map((definition) => {
          const initial = {
            model: definition.model ?? INHERIT_MODEL,
            thinking: definition.thinking,
            skills: definition.skills,
          };
          const proposed = proposal?.lists[definition.name];
          const agent = {
            name: definition.name,
            role: isLead(definition) ? ("lead" as const) : ("chore" as const),
            description: definition.description,
            tools: definition.tools,
            mcp: definition.mcp !== false,
            initial,
          };

          return proposed
            ? { ...agent, proposed: { ...initial, skills: proposed }, note: proposal?.notes[definition.name] }
            : agent;
        }),
      models: runtime.availableModels(),
      skills: runtime.skillCatalog(),
      trusted: info.projectTrusted,
      project: proposal?.project,
    });

    const leads = () => definitions.list().filter(isLead);

    const chores = () =>
      definitions
        .list()
        .filter((definition) => !isLead(definition))
        .map((definition) => definition.name);

    const startAutosetup = (info: SessionInfo) => {
      const leadAgents = leads();

      if (leadAgents.length === 0) {
        notify("no lead agents to set up", "info");
        return;
      }

      const { candidates, interactive } = candidateSkills(runtime.skillCatalog());

      if (candidates.length === 0) {
        notify("no skills to propose", "info");
        return;
      }

      host.sendHiddenMessage({
        customType: AUTOSETUP_TYPE,
        text: autosetupBrief({
          template: autosetupPrompt,
          cwd: info.cwd,
          listing: projectListing(info.cwd),
          leads: leadAgents,
          candidates,
        }),
      });

      pending = { candidates: candidates.map((skill) => skill.name), interactive };
    };

    const runForm = async () => {
      const info = host.session();
      const paths = settingsPaths(info);

      if (info.mode !== "tui") {
        const files = `${paths.project} or ${paths.user}`;
        const advice = `edit "agents" in ${files}, or run ${SETUP_USAGE}`;

        notify(`/agents setup needs the interactive terminal; ${advice}`, "error");
        return;
      }

      if (!hasSkillsOverride(settings.agents, chores())) {
        startAutosetup(info);
        return;
      }

      const choice = await host.ui.showForm(selectForm({ title: PROPOSE_TITLE, options: PROPOSE_OPTIONS }));

      if (choice === undefined) {
        return;
      }

      if (choice === "yes") {
        startAutosetup(info);
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
        chores: chores(),
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

    const awaitingInput = (waiting: boolean) =>
      host.publish(AWAITING_INPUT_CHANNEL, { source: NAMESPACE, waiting, title: "agent skills" });

    const reviewProposal = async (info: SessionInfo, proposal: Proposal, signal?: AbortSignal) => {
      awaitingInput(true);

      try {
        return await host.ui.showForm(setupForm(context(info, proposal), settingsPaths(info)), { signal });
      } finally {
        awaitingInput(false);
      }
    };

    const proposalTool: ToolSpec<ProposalParams> = {
      ...proposalDefinition,
      execute: async (params, { signal }) => {
        if (!pending) {
          return failed(NOT_PENDING);
        }

        const info = host.session();

        if (info.mode !== "tui") {
          return failed(NOT_INTERACTIVE);
        }

        const proposal = checkProposal(params, {
          agents: definitions.list().map((definition) => definition.name),
          leads: leads().map((definition) => definition.name),
          skills: pending.candidates,
          interactive: pending.interactive,
        });

        if ("error" in proposal) {
          return failed(proposal.error);
        }

        pending = undefined;

        if (proposalUnchanged(proposal, (lead) => definitions.get(lead)?.skills)) {
          return { text: NOTHING_TO_CHANGE };
        }

        const result = await reviewProposal(info, proposal, signal);

        if (!result) {
          return { text: CANCELLED };
        }

        if (result.changes.length === 0) {
          return { text: CONFIRMED_UNCHANGED };
        }

        const outcome = save(result.scope, result.changes, false);

        return "error" in outcome
          ? failed(`Not saved: ${outcome.error}.`)
          : { text: savedText(outcome.path, result.changes, outcome.warning) };
      },
    };

    host.registerTool(proposalTool);

    host.onSessionStart(() => {
      pending = undefined;
    });

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
