import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { formatTokens } from "../../../core/manager/format.ts";
import { DOT, PAD } from "../../../core/manager/layout.ts";
import { type Breakdown, type MessageKey, type Part, sumParts } from "./buckets.ts";

type Section = {
  name: string;
  hint?: string;
  parts(breakdown: Breakdown): Part[];
  one: string;
  many: string;
  onDemand?: boolean;
  expandedOnly?: boolean;
};

const SECTIONS: readonly Section[] = [
  { name: "Memory files", hint: "AGENTS.md", parts: (b) => b.memoryFiles, one: "file", many: "files" },
  { name: "Skills", hint: "/skill:<name>", parts: (b) => b.skills, one: "skill", many: "skills" },
  { name: "MCP tools", hint: "/mcp", parts: (b) => b.tools.mcp, one: "tool", many: "tools", onDemand: true },
  { name: "Extension tools", parts: (b) => b.tools.extension, one: "tool", many: "tools" },
  { name: "System tools", parts: (b) => b.tools.builtin, one: "tool", many: "tools", expandedOnly: true },
];

const BUCKETS: readonly { key: MessageKey; label: string }[] = [
  { key: "toolResults", label: "tool results" },
  { key: "assistant", label: "assistant" },
  { key: "user", label: "user" },
  { key: "thinking", label: "thinking" },
  { key: "toolCalls", label: "tool calls" },
  { key: "other", label: "other" },
];

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const branch = (theme: ThemeLike, text: string) => `${PAD}${theme.fg("dim", "└")} ${text}`;

export const title = (theme: ThemeLike, name: string, hint?: string) =>
  `${PAD}${theme.bold(name)}${hint ? theme.fg("dim", `${DOT}${hint}`) : ""}`;

const waits = (section: Section, part: Part) => section.onDemand === true && part.tokens === 0;

const byTokens = (parts: readonly Part[]) =>
  [...parts].sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));

const partText = (theme: ThemeLike, section: Section, part: Part) =>
  waits(section, part)
    ? `${part.name}: ${theme.fg("dim", "loaded on demand")}`
    : `${part.name}: ${formatTokens(part.tokens)} tokens`;

const summaryOf = (section: Section, parts: readonly Part[]) => {
  const waiting = parts.filter((part) => waits(section, part)).length;

  return [
    plural(parts.length, section.one, section.many),
    `${formatTokens(sumParts(parts))} tokens`,
    ...(waiting > 0 ? [`${waiting} loaded on demand`] : []),
  ].join(DOT);
};

const sectionLines = (theme: ThemeLike, section: Section, breakdown: Breakdown, expanded: boolean) => {
  const parts = section.parts(breakdown);

  if (parts.length === 0 || (section.expandedOnly && !expanded)) {
    return [];
  }

  const body = expanded
    ? byTokens(parts).map((part) => branch(theme, partText(theme, section, part)))
    : [branch(theme, summaryOf(section, parts))];

  return [title(theme, section.name, section.hint), ...body];
};

const messageLines = (theme: ThemeLike, messages: Breakdown["messages"], expanded: boolean) => {
  if (messages.count === 0) {
    return [];
  }

  const buckets = BUCKETS.map(({ key, label }) => ({ label, tokens: messages[key] }))
    .filter((bucket) => bucket.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);

  const summary = [
    plural(messages.count, "message", "messages"),
    ...buckets.map((bucket) => `${bucket.label} ${formatTokens(bucket.tokens)}`),
  ].join(DOT);

  const body = expanded
    ? buckets.map((bucket) => branch(theme, `${bucket.label}: ${formatTokens(bucket.tokens)} tokens`))
    : [branch(theme, summary)];

  return [title(theme, "Messages"), ...body];
};

export const detailLines = (theme: ThemeLike, breakdown: Breakdown, expanded: boolean) => [
  ...SECTIONS.flatMap((section) => sectionLines(theme, section, breakdown, expanded)),
  ...messageLines(theme, breakdown.messages, expanded),
];
