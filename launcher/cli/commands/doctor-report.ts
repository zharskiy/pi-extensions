import { asciiOf, painterOf, type Tone } from "../prompt/style.ts";
import { type CheckStatus, inLayout, type NamedCheck, SECTIONS } from "./doctor-checks.ts";
import { defaultRows, verboseRows } from "./doctor-view.ts";

export interface ReportOptions {
  verbose: boolean;
  color: boolean;
  unicode: boolean;
  home: string;
  partial?: boolean;
}

const MIN_NAME_WIDTH = 16;

const CIRCULAR_HINT = "run pinata doctor";

const MARKS: Record<CheckStatus, [string, Tone]> = {
  ok: ["✔", "green"],
  warn: ["▲", "yellow"],
  fail: ["✖", "red"],
  skip: ["-", "dim"],
};

const homeAt = (home: string) =>
  new RegExp(`(^|[\\s(:=])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "g");

const tilde = (home: string) => (text: string) =>
  home === "" || home === "/" ? text : text.replace(homeAt(home), "$1~/");

const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const markWidth = (options: ReportOptions) =>
  Math.max(...Object.values(MARKS).map(([mark]) => (options.unicode ? mark : asciiOf(mark)).length));

const checkLines = (check: NamedCheck, options: ReportOptions, width: number) => {
  const paint = painterOf(options.color);
  const shown = tilde(options.home);
  const { status, detail, reasons = [], hint } = check.result;
  const [mark, tone] = MARKS[status];
  const text = options.unicode ? mark : asciiOf(mark);
  const indent = " ".repeat(2 + markWidth(options) + 1);
  const head = `${check.name.padEnd(width)}  ${shown(detail)}`.trimEnd();
  const fix =
    hint === undefined || hint === CIRCULAR_HINT ? [] : hint.split("\n").map((line) => `→ ${shown(line)}`);

  return [
    `  ${paint(tone, text)}${" ".repeat(markWidth(options) - text.length)} ${head}`,
    ...[...reasons.map(shown), ...fix].map((line) => `${indent}${line}`),
  ];
};

const nameWidth = (rows: NamedCheck[]) =>
  rows.reduce((width, row) => Math.max(width, row.name.length), MIN_NAME_WIDTH);

const sectionBlocks = (checks: NamedCheck[], options: ReportOptions) => {
  const rows = options.verbose ? verboseRows(checks) : defaultRows(checks);
  const width = nameWidth(rows);

  return SECTIONS.map((section) => rows.filter((row) => row.section === section))
    .filter((shown) => shown.length > 0)
    .map((shown) => [
      capitalised(shown[0]?.section ?? ""),
      ...shown.flatMap((row) => checkLines(row, options, width)),
    ]);
};

const noticesBlock = (notices: string[], options: ReportOptions) =>
  notices.length === 0
    ? []
    : [
        [
          "Notices",
          ...notices.map((notice) => `  ${painterOf(options.color)("dim", tilde(options.home)(notice))}`),
        ],
      ];

const namesWith = (checks: NamedCheck[], status: CheckStatus) =>
  checks.filter((check) => check.result.status === status).map((check) => check.name);

const outcomeOf = (checks: NamedCheck[]) => {
  const failures = namesWith(checks, "fail");
  const warnings = namesWith(checks, "warn");
  const warned = `${warnings.length} warned (${warnings.join(", ")})`;

  if (failures.length === 0) {
    return warnings.length === 0 ? "All checks passed." : `No check failed, ${warned}.`;
  }

  const failed = `${failures.length} check${failures.length === 1 ? "" : "s"} failed (${failures.join(", ")})`;

  return warnings.length === 0 ? `${failed}.` : `${failed} and ${warned}.`;
};

export const renderReport = (checks: NamedCheck[], notices: string[], options: ReportOptions) => {
  const ordered = inLayout(checks);
  const outcome = options.partial === true ? [] : [[outcomeOf(ordered)]];
  const lines = [...sectionBlocks(ordered, options), ...noticesBlock(notices, options), ...outcome].flatMap(
    (block, index) => (index === 0 ? block : ["", ...block]),
  );

  return options.unicode ? lines : lines.map(asciiOf);
};
