import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime, Host, SkillInfo } from "../../../../pi-adapter/index.ts";
import type { AgentDefinitions } from "../model/agent-record.ts";
import { PLAIN_NAME, PLAIN_NAME_TEXT } from "../model/agent-schema.ts";
import { NAMESPACE, projectAgentsDir, userAgentsDir } from "../model/paths.ts";
import { type AgentKind, agentTemplate } from "./agent-template.ts";

const CREATE_TYPE = "pi-subagents-create";

export const CREATE_USAGE = "/agents create [<name> [project] | <what the agent is for>]";

type CreateRequest = { name?: string; project: boolean; purpose?: string };

type BriefInput = {
  template: string;
  args: string;
  request: CreateRequest;
  userDir: string;
  projectDir: string;
  trusted: boolean;
  taken: string[];
  skills: SkillInfo[];
};

type CreateDeps = {
  host: Host;
  template: string;
  definitions: AgentDefinitions;
  runtime: AgentRuntime;
};

const parseCreateArgs = (args: string): CreateRequest | { error: string } => {
  const text = args.trim();
  const [first, ...rest] = text.split(/\s+/).filter(Boolean);

  if (!first) {
    return { project: false };
  }

  const scoped = rest.length === 1 && rest[0] === "project";

  if (PLAIN_NAME.test(first) && (rest.length === 0 || scoped)) {
    return { name: first, project: scoped };
  }

  if (scoped) {
    return { error: `agent name "${first}" must use ${PLAIN_NAME_TEXT}` };
  }

  return { project: false, purpose: text.replace(/\s+/g, " ") };
};

const knownText = ({ name, purpose }: CreateRequest) => {
  if (purpose) {
    return `The user describes it as: "${purpose}". `;
  }

  return name ? `Its name is ${name}. ` : "";
};

const fileText = ({ request, userDir, projectDir, trusted }: BriefInput) => {
  if (request.name) {
    return `Write it to ${join(request.project ? projectDir : userDir, `${request.name}.md`)}.`;
  }

  const user = join(userDir, "<name>.md");

  if (!trusted) {
    return `Write it to ${user}. This project is not trusted, so project agents are not loaded; do not write one.`;
  }

  return (
    `Write it to ${user} (a user agent, available in every project); write it to ` +
    `${join(projectDir, "<name>.md")} instead only when the user wants it for this project alone.`
  );
};

const skillsText = (skills: SkillInfo[]) =>
  skills.length === 0 ? "none" : skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");

const skeleton = (kind: AgentKind) =>
  agentTemplate({ name: "<name>", description: "", kind, model: "" }).trimEnd();

const createBrief = (input: BriefInput): string => {
  const command = ["/agents create", input.args.trim().replace(/\s+/g, " ")].filter(Boolean).join(" ");
  const values: Record<string, string> = {
    command,
    known: knownText(input.request),
    askName: input.request.name
      ? ""
      : " Either way, agree on a short name with the user (or propose one) before writing.",
    file: fileText(input),
    taken: input.taken.join(", ") || "none",
    skills: skillsText(input.skills),
    lead: skeleton("lead"),
    chore: skeleton("chore"),
  };

  return input.template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
};

const targetProblem = (name: string, project: boolean, path: string, shipped: string[], trusted: boolean) => {
  if (shipped.includes(name)) {
    return `"${name}" is a shipped agent; pick another name`;
  }

  if (project && !trusted) {
    return "project agents need a trusted project; create a user agent with /agents create <name>";
  }

  return existsSync(path) ? `${path} already exists; edit it instead` : undefined;
};

export const createAgentCommand =
  ({ host, template, definitions, runtime }: CreateDeps) =>
  async (args: string) => {
    const fail = (message: string) => host.ui.notify(`${NAMESPACE}: ${message}`, "error");
    const request = parseCreateArgs(args);

    if ("error" in request) {
      fail(request.error);
      return;
    }

    const info = host.session();
    const userDir = userAgentsDir(info);
    const projectDir = projectAgentsDir(info);
    const loaded = definitions.list();

    if (request.name) {
      const path = join(request.project ? projectDir : userDir, `${request.name}.md`);
      const shipped = loaded.filter((definition) => definition.source === "builtin").map((d) => d.name);
      const problem = targetProblem(request.name, request.project, path, shipped, info.projectTrusted);

      if (problem) {
        fail(problem);
        return;
      }
    }

    host.sendHiddenMessage({
      customType: CREATE_TYPE,
      text: createBrief({
        template,
        args,
        request,
        userDir,
        projectDir,
        trusted: info.projectTrusted,
        taken: loaded.map((definition) => definition.name),
        skills: runtime.skillCatalog(),
      }),
    });
    host.ui.notify(
      `${NAMESPACE}: asked the main session to create the agent; answer its questions, then /reload`,
      "info",
    );
  };
