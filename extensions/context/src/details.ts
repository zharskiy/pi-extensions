import { counted, formatTokens } from "../../../core/manager/format.ts";
import { DOT } from "../../../core/manager/layout.ts";
import { MARKS } from "../../../core/manager/marks.ts";
import { TITLE_COLUMN } from "../../../core/manager/row.ts";
import type { ThemeLike } from "../../../pi-adapter/index.ts";
import { type Breakdown, type MessageKey, type Part, sumParts } from "./buckets.ts";

type Section = {
  name: string;
  hint?: string;
  parts(breakdown: Breakdown): Part[];
  one: string;
  onDemand?: boolean;
  expandedOnly?: boolean;
};

const SECTIONS: readonly Section[] = [
  { name: "Memory files", hint: "AGENTS.md", parts: (b) => b.memoryFiles, one: "file" },
  { name: "Skills", hint: "/skill:<name>", parts: (b) => b.skills, one: "skill" },
  { name: "MCP tools", hint: "/mcp", parts: (b) => b.tools.mcp, one: "tool", onDemand: true },
  { name: "Extension tools", parts: (b) => b.tools.extension, one: "tool" },
  { name: "System tools", parts: (b) => b.tools.builtin, one: "tool", expandedOnly: true },
];

const BUCKETS: readonly { key: MessageKey; label: string }[] = [
  { key: "toolResults", label: "tool results" },
  { key: "assistant", label: "assistant" },
  { key: "user", label: "user" },
  { key: "thinking", label: "thinking" },
  { key: "toolCalls", label: "tool calls" },
  { key: "other", label: "other" },
];

const children = (theme: ThemeLike, texts: string[]) =>
  texts.map((text, index) =>
    index === 0
      ? `${theme.fg("dim", MARKS.child)} ${theme.fg("muted", text)}`
      : `${" ".repeat(TITLE_COLUMN)}${theme.fg("muted", text)}`,
  );

const title = (theme: ThemeLike, name: string, hint?: string) =>
  `${theme.bold(name)}${hint ? theme.fg("dim", `${DOT}${hint}`) : ""}`;

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
    counted(parts.length, section.one),
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
    ? children(
        theme,
        byTokens(parts).map((part) => partText(theme, section, part)),
      )
    : children(theme, [summaryOf(section, parts)]);

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
    counted(messages.count, "message"),
    ...buckets.map((bucket) => `${bucket.label} ${formatTokens(bucket.tokens)}`),
  ].join(DOT);

  const body = expanded
    ? children(
        theme,
        buckets.map((bucket) => `${bucket.label}: ${formatTokens(bucket.tokens)} tokens`),
      )
    : children(theme, [summary]);

  return [title(theme, "Messages"), ...body];
};

const bucketCount = (messages: Breakdown["messages"]) =>
  messages.count === 0 ? 0 : BUCKETS.filter(({ key }) => messages[key] > 0).length;

export const itemCount = (breakdown: Breakdown) =>
  SECTIONS.reduce((sum, section) => sum + section.parts(breakdown).length, 0) +
  bucketCount(breakdown.messages);

export const detailLines = (theme: ThemeLike, breakdown: Breakdown, expanded: boolean) => [
  ...SECTIONS.flatMap((section) => sectionLines(theme, section, breakdown, expanded)),
  ...messageLines(theme, breakdown.messages, expanded),
];
