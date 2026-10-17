import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Host } from "../../../../../core/adapter/contract.ts";
import { errorText } from "../../components/format.ts";
import { overrideModel } from "../../model/agent-override.ts";
import { PLAIN_NAME, PLAIN_NAME_TEXT } from "../../model/agent-schema.ts";
import { NAMESPACE, projectAgentsDir, userAgentsDir } from "../../model/paths.ts";
import { agentTemplate } from "./agent-template.ts";
import { type CreateAnswers, createAgentForm } from "./create-form.ts";

export const CREATE_USAGE = "/agents create <name> [project]";

type CreateRequest = { name: string; project: boolean };

type CreateDeps = { host: Host; shippedNames: () => string[] };

const DEFAULT_ANSWERS: CreateAnswers = { description: "", kind: "lead", model: "" };

export const parseCreateArgs = (args: string): CreateRequest | { error: string } => {
  const [name, scope, ...rest] = args.trim().split(/\s+/).filter(Boolean);

  if (!name || rest.length > 0 || (scope !== undefined && scope !== "project")) {
    return { error: `usage: ${CREATE_USAGE}` };
  }

  if (!PLAIN_NAME.test(name)) {
    return { error: `agent name "${name}" must use ${PLAIN_NAME_TEXT}` };
  }

  return { name, project: scope === "project" };
};

const targetProblem = (request: CreateRequest, path: string, shipped: string[], trusted: boolean) => {
  if (shipped.includes(request.name)) {
    return `"${request.name}" is a shipped agent; pick another name`;
  }

  if (request.project && !trusted) {
    return "project agents need a trusted project; create a user agent with /agents create <name>";
  }

  return existsSync(path) ? `${path} already exists; edit it instead` : undefined;
};

const modelProblem = (model: string) => (model.trim() ? overrideModel(model).error : undefined);

export const createAgentCommand =
  ({ host, shippedNames }: CreateDeps) =>
  async (args: string) => {
    const fail = (message: string) => host.ui.notify(`${NAMESPACE}: ${message}`, "error");
    const request = parseCreateArgs(args);

    if ("error" in request) {
      fail(request.error);
      return;
    }

    const info = host.session();
    const dir = request.project ? projectAgentsDir(info) : userAgentsDir(info);
    const path = join(dir, `${request.name}.md`);
    const problem = targetProblem(request, path, shippedNames(), info.projectTrusted);

    if (problem) {
      fail(problem);
      return;
    }

    const answers =
      info.mode === "tui" ? await host.ui.showForm(createAgentForm(request.name, dir)) : DEFAULT_ANSWERS;

    if (!answers) {
      return;
    }

    const badModel = modelProblem(answers.model);

    if (badModel) {
      fail(badModel);
      return;
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, agentTemplate({ name: request.name, ...answers }), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      fail(`cannot write ${path}: ${errorText(error)}`);
      return;
    }

    host.ui.notify(
      `${NAMESPACE}: created ${path}. Fill in its <...> parts, or ask the main session to, then /reload.`,
      "info",
    );
  };
