import { relativeTo } from "./plan-rows.ts";

type Severity = "high" | "medium" | "low";

export type FindingRef = { path: string; start: number; end: number };

export type Finding = { text: string; severity?: Severity; refs: FindingRef[] };

const SECTIONS =
  /^(findings|verdict|status|open|summary|changes|notes?|tests?|verification)\b[*_]*(:?)[*_]*(.*)$/i;

const ITEM = /^\s*(?:[-*]|\d+[.)]|\[(?:high|medium|low)\])/i;

const SEVERITY = /\[\s*(high|medium|low)\s*\]|\b(high|medium|low)\b\s*[:\]-]/i;

const REF = /([\w@./-]*[\w-]\.[A-Za-z]\w*)(?::(\d+)(?:[-–](\d+))?|#L(\d+)(?:-L?(\d+))?)/g;

const header = (line: string) => {
  const heading = /^\s*#/.test(line);
  const match = SECTIONS.exec(line.replace(/^[\s>#*_]+/, ""));

  if (!match || (!heading && match[2] !== ":" && match[3].trim() !== "")) {
    return undefined;
  }

  return { name: match[1].toLowerCase(), rest: match[3].replace(/^[\s*_]+/, "").trim() };
};

const findingsBlock = (lines: string[]) => {
  const start = lines.findIndex((line) => header(line)?.name === "findings");

  if (start < 0) {
    return undefined;
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const name = header(line)?.name;

    return name !== undefined && name !== "findings";
  });
  const inline = header(lines[start])?.rest ?? "";

  return [...(inline ? [inline] : []), ...(end < 0 ? rest : rest.slice(0, end))];
};

export const findingRefs = (line: string): FindingRef[] =>
  Array.from(line.matchAll(REF)).map((match) => {
    const start = Number(match[2] ?? match[4]);
    const end = Number(match[3] ?? match[5] ?? start);

    return { path: match[1].replace(/^\.\//, ""), start, end: Math.max(start, end) };
  });

const severityOf = (line: string) =>
  (SEVERITY.exec(line)?.slice(1).find(Boolean)?.toLowerCase() as Severity | undefined) ?? undefined;

export const parseFindings = (text: string): Finding[] => {
  const lines = text.split("\n");
  const block = findingsBlock(lines);
  const items = block
    ? block.filter((line) => ITEM.test(line) || /\[(high|medium|low)\]/i.test(line))
    : lines.filter((line) => /\[(high|medium|low)\]/i.test(line));

  return items.map((line) => ({ text: line.trim(), severity: severityOf(line), refs: findingRefs(line) }));
};

const samePath = (roots: string[], written: string, file: string) => {
  const path = relativeTo(roots, written);

  return path === file || file.endsWith(`/${path}`);
};

export const hitsLine = (
  findings: Finding[],
  target: { file: string; line: number; slack: number; roots?: string[] },
) =>
  findings.some((finding) =>
    finding.refs.some(
      (ref) =>
        samePath(target.roots ?? [], ref.path, target.file) &&
        ref.start - target.slack <= target.line &&
        target.line <= ref.end + target.slack,
    ),
  );

export const citesFile = (findings: Finding[], file: string, roots: string[] = []) =>
  findings.some(
    (finding) => finding.text.includes(file) || finding.refs.some((ref) => samePath(roots, ref.path, file)),
  );

export type ToolOutput = { toolName: string; text: string };

export const largestOutput = (items: ToolOutput[], toolName: string) =>
  items
    .filter((item) => item.toolName === toolName)
    .reduce((max, item) => Math.max(max, item.text.length), 0);
