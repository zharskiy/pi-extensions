import { readdirSync } from "node:fs";
import { basename, relative } from "node:path";
import type { SessionInfo, SkillInfo } from "../../../../platform/pi-adapter/index.ts";
import { errorText, readText } from "../../../../platform/shared/index.ts";
import { cutChars } from "../components/receipt.ts";
import { type AgentDefinition, type AgentSource, grantText } from "../model/agent-record.ts";
import { AGENT_SCOPE_ALL, type AgentOverrides } from "../model/agent-schema.ts";
import { builtinAgentsDir, projectAgentsDir, userAgentsDir } from "../model/paths.ts";

export const AUTOSETUP_TYPE = "pi-subagents-autosetup";

export const INTERACTIVE_TERMS = [
  "AskUserQuestion",
  "questionnaire",
  "ask_user",
  "ask the user",
  "confirm with the user",
];

export const DESCRIPTION_LIMIT = 200;

const LISTING_LIMIT = 60;

const SKIPPED_ENTRIES = [".git", "node_modules"];

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

export type AgentDirs = Record<AgentSource, string>;

type BriefInput = {
  template: string;
  cwd: string;
  listing: string;
  leads: AgentDefinition[];
  candidates: SkillInfo[];
};

export const agentDirs = (info: Pick<SessionInfo, "cwd" | "agentDir">, root: string): AgentDirs => ({
  builtin: builtinAgentsDir(root),
  user: userAgentsDir(info),
  project: projectAgentsDir(info),
});

export const isChore = (relativePath: string) => relativePath.split(/[\\/]/).slice(0, -1).includes("chores");

export const isLead = (definition: AgentDefinition, dirs: AgentDirs) =>
  definition.skills !== AGENT_SCOPE_ALL && !isChore(relative(dirs[definition.source], definition.path));

export const hasSkillsOverride = (agents: AgentOverrides) =>
  Object.values(agents).some((override) => override.skills !== undefined);

const isInteractive = (text: string) => {
  const lower = text.toLowerCase();

  return INTERACTIVE_TERMS.some((term) => lower.includes(term.toLowerCase()));
};

const readable = (read: (path: string) => string | undefined, path: string) => {
  try {
    return read(path);
  } catch {
    return undefined;
  }
};

export const candidateSkills = (
  catalog: SkillInfo[],
  read: (path: string) => string | undefined = readText,
) => {
  const interactive = catalog.filter((skill) => {
    const text = readable(read, skill.path);

    return text !== undefined && isInteractive(text.replace(FRONTMATTER, ""));
  });

  return {
    candidates: catalog.filter((skill) => !interactive.includes(skill)),
    interactive: interactive.map((skill) => skill.name),
  };
};

export const leftOutText = (interactive: string[]) =>
  interactive.length === 0 ? "" : `; left out, interactive: ${interactive.join(", ")}`;

export const projectListing = (cwd: string, limit = LISTING_LIMIT) => {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => !SKIPPED_ENTRIES.includes(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort();
    const shown = entries.slice(0, limit).join(", ") || "(empty)";

    return entries.length > limit ? `${shown} and ${entries.length - limit} more` : shown;
  } catch (error) {
    return `(cannot list: ${errorText(error)})`;
  }
};

const leadLine = (lead: AgentDefinition) =>
  `- ${lead.name}: ${lead.description} | tools: ${grantText(lead.tools) || "none"} | skills: ${grantText(lead.skills) || "none"}`;

const skillLine = (skill: SkillInfo) => {
  const name = skill.scope === "project" ? `${skill.name} [project]` : skill.name;

  return skill.description
    ? `- ${name}: ${cutChars(skill.description, DESCRIPTION_LIMIT)}`
    : `- ${name} (no description)`;
};

export const autosetupBrief = ({ template, cwd, listing, leads, candidates }: BriefInput) => {
  const values: Record<string, string> = {
    project: `${basename(cwd)} (${cwd})`,
    listing,
    leads: leads.map(leadLine).join("\n"),
    skills: candidates.map(skillLine).join("\n"),
  };

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
};
