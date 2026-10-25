import type { ToolSpec } from "../../../../platform/pi-adapter/index.ts";
import { sameGrant } from "../model/agent-record.ts";
import type { Grant } from "../model/agent-schema.ts";
import type { SetupChange } from "./scope.ts";

export const PROPOSAL_TOOL = "agent_skills_proposal";

const MAX_SKILLS = 5;

export const NEW_SESSION_HINT = "start a new session with /new to free the tokens the setup took";

export const NOT_PENDING = "Error: no skills proposal is pending; the user must run /agents setup first.";

export const NOT_INTERACTIVE = `Error: ${PROPOSAL_TOOL} needs the interactive terminal; nothing was saved.`;

export const NOTHING_TO_CHANGE = "Nothing to change: the proposal matches the current lists.";

export const CANCELLED = "Cancelled by the user; nothing was saved.";

export const CONFIRMED_UNCHANGED = "The user confirmed without changes; nothing was saved.";

export type ProposalParams = {
  project: string;
  assignments: { lead: string; skills: string[] }[];
  reasons: { skill: string; why: string }[];
};

export type Proposal = { project: string; lists: Record<string, string[]>; notes: Record<string, string> };

type Known = { agents: string[]; leads: string[]; skills: string[]; interactive: string[] };

type Assignment = ProposalParams["assignments"][number];

const PARAMETERS = {
  type: "object",
  properties: {
    project: { type: "string", description: "One line: what kind of project this is." },
    assignments: {
      type: "array",
      description: `One entry per lead agent whose list should change: its full list, most useful first, at most ${MAX_SKILLS} skills; [] for none.`,
      items: {
        type: "object",
        properties: {
          lead: { type: "string", description: "Lead agent name." },
          skills: { type: "array", items: { type: "string" }, description: "Skill names." },
        },
        required: ["lead", "skills"],
        additionalProperties: false,
      },
    },
    reasons: {
      type: "array",
      description: "One entry per proposed skill: one line saying why it fits.",
      items: {
        type: "object",
        properties: { skill: { type: "string" }, why: { type: "string" } },
        required: ["skill", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["project", "assignments", "reasons"],
  additionalProperties: false,
};

export const proposalDefinition: Pick<
  ToolSpec<ProposalParams>,
  "name" | "label" | "description" | "parameters" | "executionMode" | "modelOnly"
> = {
  name: PROPOSAL_TOOL,
  label: "Agent skills proposal",
  description: `Answer a skills brief from /agents setup: the project kind and up to ${MAX_SKILLS} skills per lead agent, most useful first. Only valid right after that brief; opens a form the user confirms.`,
  parameters: PARAMETERS,
  executionMode: "sequential",
  modelOnly: true,
};

const skillProblem = (skill: string, known: Known) =>
  known.interactive.includes(skill)
    ? `"${skill}" asks the user; agents cannot use it`
    : `no skill named "${skill}" here`;

const assignmentProblems = (assignment: Assignment, known: Known) => {
  if (!known.agents.includes(assignment.lead)) {
    return [`no agent named "${assignment.lead}"`];
  }

  if (!known.leads.includes(assignment.lead)) {
    return [`${assignment.lead} is not set up here`];
  }

  const unknown = assignment.skills.filter((skill) => !known.skills.includes(skill));
  const tooMany =
    assignment.skills.length > MAX_SKILLS ? [`${assignment.lead}: at most ${MAX_SKILLS} skills`] : [];

  return [...unknown.map((skill) => skillProblem(skill, known)), ...tooMany];
};

const noteFor = (list: string[], reasons: ProposalParams["reasons"]) => {
  const lines = list.flatMap((skill) => {
    const reason = reasons.find((entry) => entry.skill === skill);

    return reason ? [`${skill}: ${reason.why}`] : [];
  });

  return lines.join("; ");
};

export const checkProposal = (params: ProposalParams, known: Known): Proposal | { error: string } => {
  const assignments = (params.assignments ?? []).map((assignment) => ({
    lead: assignment.lead,
    skills: [...new Set(assignment.skills)],
  }));
  const leads = assignments.map((assignment) => assignment.lead);
  const repeated = leads.filter((lead, index) => leads.indexOf(lead) !== index);
  const problems = [
    ...(params.project?.trim() ? [] : ["project: say in one line what kind of project this is"]),
    ...[...new Set(repeated)].map((lead) => `${lead} is listed more than once`),
    ...assignments.flatMap((assignment) => assignmentProblems(assignment, known)),
  ];

  if (problems.length > 0) {
    const names = `Lead agents: ${known.leads.join(", ") || "none"}. Skills: ${known.skills.join(", ") || "none"}.`;

    return { error: `Error: ${problems.join("; ")}. ${names} Fix the call and call again.` };
  }

  const lists = Object.fromEntries(assignments.map((assignment) => [assignment.lead, assignment.skills]));
  const notes = Object.fromEntries(
    Object.entries(lists).map(([lead, list]) => [lead, noteFor(list, params.reasons)]),
  );

  return { project: params.project.trim(), lists, notes };
};

export const proposalUnchanged = (proposal: Proposal, current: (lead: string) => Grant | undefined) =>
  Object.entries(proposal.lists).every(([lead, list]) => {
    const grant = current(lead);

    return grant !== undefined && sameGrant(grant, list);
  });

const valueText = (value: unknown) => (Array.isArray(value) ? `[${value.join(", ")}]` : String(value));

export const savedText = (path: string, changes: SetupChange[], warning?: string) => {
  const saved = changes
    .map(
      (change) =>
        `${change.name} ${Object.entries(change.patch)
          .map(([field, value]) => `${field} ${valueText(value)}`)
          .join(", ")}`,
    )
    .join("; ");
  const shadowed = warning ? ` Note: ${warning}.` : "";

  return `Saved to ${path}: ${saved}. Agents started from now on use them.${shadowed} Tell the user what was saved, and suggest they ${NEW_SESSION_HINT}.`;
};
