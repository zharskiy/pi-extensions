const HANDOFF_SECTIONS = ["Status", "Outcome", "Evidence", "Blocker", "Next", "Files touched"] as const;

export type HandoffValidation = { ok: true; status: string } | { ok: false; errors: string[] };

type Heading = { title: string; line: number };

const headingsOf = (lines: string[]): Heading[] =>
  lines.flatMap((line, index) => {
    const match = /^##\s+(.+?)\s*$/.exec(line);

    return match ? [{ title: match[1], line: index }] : [];
  });

const bodyOf = (lines: string[], headings: Heading[], position: number) => {
  const start = headings[position].line + 1;
  const end = headings[position + 1]?.line ?? lines.length;

  return lines.slice(start, end).join("\n").trim();
};

export const validateHandoff = (text: string, statuses: readonly string[]): HandoffValidation => {
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

  if (statusPosition >= 0 && !statuses.includes(statusWord)) {
    errors.push(`Status must be one of ${statuses.join(", ")}`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, status: statusWord };
};
