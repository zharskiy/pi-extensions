import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Host } from "../../../../../core/adapter/contract.ts";
import { errorText } from "../../components/format.ts";
import { NAMESPACE } from "../../model/paths.ts";
import { AGENT_NAME, agentTemplate } from "./agent-template.ts";
import { type CreateAnswers, createAgentForm } from "./create-form.ts";

export const CREATE_USAGE = "/agents create <name> [project]";

type CreateRequest = { name: string; project: boolean };

const DEFAULT_ANSWERS: CreateAnswers = { description: "", kind: "lead", model: "" };

export const parseCreateArgs = (args: string): CreateRequest | { error: string } => {
  const [name, scope, ...rest] = args.trim().split(/\s+/).filter(Boolean);

  if (!name || rest.length > 0 || (scope !== undefined && scope !== "project")) {
    return { error: `usage: ${CREATE_USAGE}` };
  }

  if (!AGENT_NAME.test(name)) {
    return { error: `agent name "${name}" must use letters, digits, '_' and '-', not starting with '-'` };
  }

  return { name, project: scope === "project" };
};

export const shippedAgentNames = (root: string) => {
  const dir = join(root, "agents");

  if (!existsSync(dir)) {
    return new Set<string>();
  }

  return new Set(
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".md"))
      .map((file) => basename(file, ".md")),
  );
};

const targetProblem = (request: CreateRequest, path: string, shipped: Set<string>, trusted: boolean) => {
  if (shipped.has(request.name)) {
    return `"${request.name}" is a shipped agent; pick another name`;
  }

  if (request.project && !trusted) {
    return "project agents need a trusted project; create a user agent with /agents create <name>";
  }

  return existsSync(path) ? `${path} already exists; edit it instead` : undefined;
};

const modelProblem = (model: string) =>
  /\s/.test(model.trim()) ? "model must be provider/id or provider/id:thinking without spaces" : undefined;

export const createAgentCommand = (host: Host, root: string) => async (args: string) => {
  const warn = (message: string) => host.ui.notify(`${NAMESPACE}: ${message}`, "warning");
  const request = parseCreateArgs(args);

  if ("error" in request) {
    warn(request.error);
    return;
  }

  const info = host.session();
  const dir = request.project ? join(info.cwd, ".pi", "agents") : join(info.agentDir, "agents");
  const path = join(dir, `${request.name}.md`);
  const problem = targetProblem(request, path, shippedAgentNames(root), info.projectTrusted);

  if (problem) {
    warn(problem);
    return;
  }

  const answers =
    info.mode === "tui" ? await host.ui.showForm(createAgentForm(request.name, dir)) : DEFAULT_ANSWERS;

  if (!answers) {
    return;
  }

  const badModel = modelProblem(answers.model);

  if (badModel) {
    warn(badModel);
    return;
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, agentTemplate({ name: request.name, ...answers }), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    warn(`cannot write ${path}: ${errorText(error)}`);
    return;
  }

  host.ui.notify(
    `${NAMESPACE}: created ${path}. Fill in its <...> parts, or ask the main session to, then /reload.`,
    "info",
  );
};
