export type AgentGroup = "leads" | "chores";

export type AgentPatch = { from: string; fields?: Record<string, string>; body?: string };

export type LiveModels = { lead: string; chore: string };

export const LIVE_LIMIT = "20000";

const frontmatterOf = (text: string) => {
  const end = text.indexOf("\n---", 4);

  return { head: text.slice(0, end), body: text.slice(end) };
};

const setField = (head: string, key: string, value: string) => {
  const line = new RegExp(`^${key}:.*$`, "m");

  return line.test(head) ? head.replace(line, `${key}: ${value}`) : `${head}\n${key}: ${value}`;
};

const GROUPS: AgentGroup[] = ["leads", "chores"];

export const shippedGroup = (from: string, exists: (group: AgentGroup) => boolean): AgentGroup => {
  const groups = GROUPS.filter(exists);

  if (groups.length > 1) {
    throw new Error(`shipped agent ${from} exists under both ${groups.join(" and ")}`);
  }

  if (groups.length === 0) {
    throw new Error(`no shipped agent named ${from}`);
  }

  return groups[0];
};

export const modelForGroup = (group: AgentGroup, models: LiveModels) =>
  group === "chores" ? models.chore : models.lead;

export const patchAgentFile = (
  source: string,
  options: { name: string; group: AgentGroup; patch: AgentPatch; models: LiveModels },
) => {
  const { head, body } = frontmatterOf(source);
  const { patch } = options;

  const fields: Record<string, string> = {
    model: modelForGroup(options.group, options.models),
    ...(options.group === "leads" ? { limit: LIVE_LIMIT } : {}),
    ...patch.fields,
    name: options.name,
  };

  const patchedHead = Object.entries(fields).reduce((text, [key, value]) => setField(text, key, value), head);

  return `${patchedHead}${patch.body === undefined ? body : `\n---\n${patch.body.trim()}\n`}`;
};
