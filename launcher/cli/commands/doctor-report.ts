import { inLayout, type NamedCheck, SECTIONS, verdictOf } from "./doctor-checks.ts";
import { defaultRows, verboseRows } from "./doctor-view.ts";

export interface ReportOptions {
  verbose: boolean;
  color: boolean;
  home: string;
  partial?: boolean;
}

const MIN_NAME_WIDTH = 16;

const STATUS_WIDTH = 4;

const INDENT = " ".repeat(2 + STATUS_WIDTH + 2);

const CIRCULAR_HINT = "run pi sandbox doctor";

const STYLE = {
  ok: "32",
  warn: "33",
  fail: "1;31",
  skip: "2",
  section: "1",
  hint: "36",
  notice: "2",
};

const VERDICT_STYLE = { ok: STYLE.ok, "ok with warnings": STYLE.warn, fail: STYLE.fail };

const paint = (color: boolean) => (code: string, text: string) =>
  color ? `\u001b[${code}m${text}\u001b[0m` : text;

const homeAt = (home: string) =>
  new RegExp(`(^|[\\s(:=])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "g");

const tilde = (home: string) => (text: string) =>
  home === "" || home === "/" ? text : text.replace(homeAt(home), "$1~/");

const checkLines = (check: NamedCheck, options: ReportOptions, width: number) => {
  const style = paint(options.color);
  const shown = tilde(options.home);
  const { status, detail, reasons = [], hint } = check.result;
  const head = `${check.name.padEnd(width)}  ${shown(detail)}`.trimEnd();
  const fix =
    hint === undefined || hint === CIRCULAR_HINT
      ? []
      : hint.split("\n").map((line) => `${style(STYLE.hint, "hint:")} ${shown(line)}`);

  return [
    `  ${style(STYLE[status], status)}${" ".repeat(STATUS_WIDTH - status.length)}  ${head}`,
    ...[...reasons.map(shown), ...fix].map((line) => `${INDENT}${line}`),
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
      paint(options.color)(STYLE.section, shown[0]?.section ?? ""),
      ...shown.flatMap((row) => checkLines(row, options, width)),
    ]);
};

const noticesBlock = (notices: string[], options: ReportOptions) =>
  notices.length === 0
    ? []
    : [
        [
          paint(options.color)(STYLE.section, "notices"),
          ...notices.map((notice) => `  ${paint(options.color)(STYLE.notice, tilde(options.home)(notice))}`),
        ],
      ];

const namesWith = (checks: NamedCheck[], status: NamedCheck["result"]["status"]) =>
  checks.filter((check) => check.result.status === status).map((check) => check.name);

const summaryOf = (checks: NamedCheck[]) => {
  const failures = namesWith(checks, "fail");
  const warnings = namesWith(checks, "warn");

  return [
    ...(failures.length === 0 ? [] : [`${failures.length} failed: ${failures.join(", ")}`]),
    ...(warnings.length === 0
      ? []
      : [`${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${warnings.join(", ")}`]),
  ].join("; ");
};

const resultBlock = (checks: NamedCheck[], options: ReportOptions) => {
  const verdict = verdictOf(checks);
  const summary = summaryOf(checks);
  const counts = summary === "" ? "" : ` (${summary})`;

  return options.partial === true
    ? []
    : [[`result: ${paint(options.color)(VERDICT_STYLE[verdict], verdict)}${counts}`]];
};

export const renderReport = (checks: NamedCheck[], notices: string[], options: ReportOptions) => {
  const ordered = inLayout(checks);

  return [
    ...sectionBlocks(ordered, options),
    ...noticesBlock(notices, options),
    ...resultBlock(ordered, options),
  ].flatMap((block, index) => (index === 0 ? block : ["", ...block]));
};
