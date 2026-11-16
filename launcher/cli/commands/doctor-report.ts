import {
  type CheckStatus,
  inLayout,
  type NamedCheck,
  passed,
  SECTIONS,
  tallyOf,
  VERBOSE_FLAG,
  verdictOf,
} from "./doctor-checks.ts";

export interface ReportOptions {
  verbose: boolean;
  color: boolean;
  home: string;
  partial?: boolean;
}

const NAME_WIDTH = 16;

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

const isPassingRule = (check: NamedCheck) => check.group === "rules" && check.result.status === "ok";

const rulesSummary = (count: number, others: boolean): NamedCheck => ({
  name: "rules",
  section: "credentials",
  result: passed(
    `${count} ${others ? "other " : ""}credential host${count === 1 ? "" : "s"} answered through the proxy (${VERBOSE_FLAG} lists them)`,
  ),
});

const collapsed = (checks: NamedCheck[], verbose: boolean) => {
  const passing = checks.filter(isPassingRule).length;

  if (verbose || passing === 0) {
    return checks;
  }

  const last = checks.findLastIndex((check) => check.group === "rules");
  const others = checks.some((check) => check.group === "rules" && !isPassingRule(check));

  return checks.flatMap((check, index) => [
    ...(isPassingRule(check) ? [] : [check]),
    ...(index === last ? [rulesSummary(passing, others)] : []),
  ]);
};

const checkLines = (check: NamedCheck, options: ReportOptions) => {
  const style = paint(options.color);
  const shown = tilde(options.home);
  const { status, detail, reasons = [], hint } = check.result;
  const head = `${check.name.padEnd(NAME_WIDTH)}  ${shown(detail)}`.trimEnd();
  const fix =
    hint === undefined || hint === CIRCULAR_HINT
      ? []
      : hint.split("\n").map((line) => `${style(STYLE.hint, "hint:")} ${shown(line)}`);

  return [
    `  ${style(STYLE[status], status)}${" ".repeat(STATUS_WIDTH - status.length)}  ${head}`,
    ...[...reasons.map(shown), ...fix].map((line) => `${INDENT}${line}`),
  ];
};

const sectionBlocks = (checks: NamedCheck[], options: ReportOptions) =>
  SECTIONS.map((section) =>
    collapsed(
      checks.filter((check) => check.section === section),
      options.verbose,
    ),
  )
    .filter((rows) => rows.length > 0)
    .map((rows) => [
      paint(options.color)(STYLE.section, rows[0]?.section ?? ""),
      ...rows.flatMap((row) => checkLines(row, options)),
    ]);

const noticesBlock = (notices: string[], options: ReportOptions) =>
  notices.length === 0
    ? []
    : [
        [
          paint(options.color)(STYLE.section, "notices"),
          ...notices.map((notice) => `  ${paint(options.color)(STYLE.notice, tilde(options.home)(notice))}`),
        ],
      ];

const COUNTS: Array<[CheckStatus, (count: number) => string]> = [
  ["fail", (count) => `${count} failed`],
  ["warn", (count) => `${count} warning${count === 1 ? "" : "s"}`],
  ["ok", (count) => `${count} ok`],
  ["skip", (count) => `${count} skipped`],
];

const summaryOf = (checks: NamedCheck[]) => {
  const tally = tallyOf(checks);

  return COUNTS.filter(([status]) => tally[status] > 0)
    .map(([status, text]) => text(tally[status]))
    .join(", ");
};

const resultBlock = (checks: NamedCheck[], options: ReportOptions) => {
  const verdict = verdictOf(checks);

  return options.partial === true
    ? []
    : [[`result: ${paint(options.color)(VERDICT_STYLE[verdict], verdict)} (${summaryOf(checks)})`]];
};

export const renderReport = (checks: NamedCheck[], notices: string[], options: ReportOptions) => {
  const ordered = inLayout(checks);

  return [
    ...sectionBlocks(ordered, options),
    ...noticesBlock(notices, options),
    ...resultBlock(ordered, options),
  ].flatMap((block, index) => (index === 0 ? block : ["", ...block]));
};
