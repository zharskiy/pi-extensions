import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionInfo } from "./adapter/contract.ts";

export const HANDOFF_FILE = "main-handoff.md";

export const HANDOFF_SECTIONS = [
  "Status",
  "Outcome",
  "Evidence",
  "Blocker",
  "Next",
  "Files touched",
] as const;

export const HANDOFF_STATUSES = ["done", "partial", "blocked"] as const;

export type HandoffValidation = { ok: true; status: string } | { ok: false; errors: string[] };

type Heading = { title: string; line: number };

export const handoffPath = (info: SessionInfo | undefined) => {
  if (!info) {
    return join(tmpdir(), "pi-session-limits", "no-session", HANDOFF_FILE);
  }

  if (info.file) {
    return join(info.file.replace(/\.jsonl$/, ""), HANDOFF_FILE);
  }

  return join(tmpdir(), "pi-session-limits", info.id, HANDOFF_FILE);
};

export const instructionFor = (template: string, path: string) =>
  template.replaceAll("{{path}}", path).trim();

export const seedText = (previousSession: string | undefined, handoff: string) => {
  const source = previousSession ? `the previous session ${previousSession}` : "the previous session";

  const preface = `This session continues ${source}, which reached its context limit. Its handoff follows; use it as your context and keep helping the user from where it left off.`;

  return [preface, "", handoff.trim()].join("\n");
};

const headingsOf = (lines: string[]): Heading[] =>
  lines
    .map((line, index) => ({ match: /^##\s+(.+?)\s*$/.exec(line), index }))
    .filter((entry) => entry.match !== null)
    .map((entry) => ({ title: entry.match?.[1] ?? "", line: entry.index }));

const bodyOf = (lines: string[], headings: Heading[], position: number) => {
  const start = headings[position].line + 1;
  const end = headings[position + 1]?.line ?? lines.length;

  return lines.slice(start, end).join("\n").trim();
};

const isStatus = (word: string): word is (typeof HANDOFF_STATUSES)[number] =>
  HANDOFF_STATUSES.some((status) => status === word);

export const validateHandoff = (text: string): HandoffValidation => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headings = headingsOf(lines);
  const titles = headings.map((heading) => heading.title.toLowerCase());
  const positionOf = (section: string) => titles.indexOf(section.toLowerCase());
  const errors: string[] = [];

  const missing = HANDOFF_SECTIONS.filter((section) => positionOf(section) < 0);

  if (missing.length > 0) {
    errors.push(`missing sections: ${missing.join(", ")}`);
  }

  const positions = HANDOFF_SECTIONS.map(positionOf).filter((position) => position >= 0);
  const ordered = positions.every((position, index) => index === 0 || position > positions[index - 1]);

  if (!ordered) {
    errors.push(`sections must appear in this order: ${HANDOFF_SECTIONS.join(", ")}`);
  }

  const empty = HANDOFF_SECTIONS.filter((section) => {
    const position = positionOf(section);

    return position >= 0 && bodyOf(lines, headings, position).length === 0;
  });

  if (empty.length > 0) {
    errors.push(`empty sections: ${empty.join(", ")}`);
  }

  const statusPosition = positionOf("Status");
  const statusLine = statusPosition >= 0 ? bodyOf(lines, headings, statusPosition).split("\n")[0] : "";
  const statusWord = statusLine
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");

  if (statusPosition >= 0 && !isStatus(statusWord)) {
    errors.push(`Status must be one of ${HANDOFF_STATUSES.join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, status: statusWord };
};
