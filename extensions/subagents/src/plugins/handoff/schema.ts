import type { HandoffValidation } from "../../model/types.ts";

export const HANDOFF_SECTIONS = [
  "Status",
  "Outcome",
  "Evidence",
  "Blocker",
  "Next",
  "Files touched",
] as const;

export const HANDOFF_STATUSES = ["partial", "blocked"] as const;

type Heading = { title: string; line: number };

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

export const validateHandoff = (text: string): HandoffValidation => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const headings = headingsOf(lines);
  const titles = headings.map((heading) => heading.title.toLowerCase());
  const errors: string[] = [];

  const missing = HANDOFF_SECTIONS.filter((section) => !titles.includes(section.toLowerCase()));

  if (missing.length > 0) {
    errors.push(`missing sections: ${missing.join(", ")}`);
  }

  const positions = HANDOFF_SECTIONS.map((section) => titles.indexOf(section.toLowerCase())).filter(
    (position) => position >= 0,
  );

  const ordered = positions.every((position, index) => index === 0 || position > positions[index - 1]);

  if (!ordered) {
    errors.push(`sections must appear in this order: ${HANDOFF_SECTIONS.join(", ")}`);
  }

  const empty = HANDOFF_SECTIONS.filter((section) => {
    const position = titles.indexOf(section.toLowerCase());

    return position >= 0 && bodyOf(lines, headings, position).length === 0;
  });

  if (empty.length > 0) {
    errors.push(`empty sections: ${empty.join(", ")}`);
  }

  const statusPosition = titles.indexOf("status");
  const status =
    statusPosition >= 0 ? bodyOf(lines, headings, statusPosition).split("\n")[0].trim().toLowerCase() : "";
  const statusWord = status.replace(/[^a-z]/g, "");

  if (statusPosition >= 0 && !HANDOFF_STATUSES.includes(statusWord as (typeof HANDOFF_STATUSES)[number])) {
    errors.push(`Status must be one of ${HANDOFF_STATUSES.join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, status: statusWord };
};
