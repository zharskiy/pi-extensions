export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  status: CheckStatus;
  detail: string;
  reasons?: string[];
  hint?: string;
}

export type Section = "host" | "sandbox" | "network" | "credentials" | "leak sweep";

export interface NamedCheck {
  name: string;
  section: Section;
  result: CheckResult;
  group?: "rules";
}

interface Explained {
  reasons?: string[];
  hint?: string;
}

export interface ReportOptions {
  verbose: boolean;
  color: boolean;
  home: string;
  partial?: boolean;
}

export const VERBOSE_FLAG = "--verbose";

const NAME_WIDTH = 16;

const STATUS_WIDTH = 4;

const INDENT = " ".repeat(2 + STATUS_WIDTH + 2);

const CIRCULAR_HINT = "run pi sandbox doctor";

const LAYOUT: Array<[Section, string[]]> = [
  ["host", ["user config", "old state", "host pi", "provider hosts", "sessions", "host side"]],
  [
    "sandbox",
    ["vm shares", "vm", "sandbox", "vm size", "image", "container", "sync", "sessions share", "probes"],
  ],
  ["network", ["proxy", "proxy health", "parent proxy", "no-route", "mcp", "blocked"]],
  ["credentials", ["trust", "rule", "rules", "mcp"]],
  ["leak sweep", ["credential sweep", "mcp-auth sweep", "settings sweep"]],
];

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

const resultOf =
  (status: CheckStatus) =>
  (detail: string, more: Explained = {}): CheckResult => ({
    status,
    detail,
    ...(more.reasons === undefined || more.reasons.length === 0 ? {} : { reasons: more.reasons }),
    ...(more.hint === undefined ? {} : { hint: more.hint }),
  });

export const passed = resultOf("ok");

export const warned = resultOf("warn");

export const failed = resultOf("fail");

export const skipped = resultOf("skip");

const paint = (color: boolean) => (code: string, text: string) =>
  color ? `\u001b[${code}m${text}\u001b[0m` : text;

const homeAt = (home: string) =>
  new RegExp(`(^|[\\s(:=])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "g");

const tilde = (home: string) => (text: string) =>
  home === "" || home === "/" ? text : text.replace(homeAt(home), "$1~/");

const sectionIndex = (section: Section) => LAYOUT.findIndex(([name]) => name === section);

const rankOf = (check: NamedCheck) => {
  const order = LAYOUT[sectionIndex(check.section)]?.[1] ?? [];
  const exact = order.indexOf(check.name);
  const family = order.indexOf(check.name.split(" ")[0] ?? "");

  return exact >= 0 ? exact : family >= 0 ? family : order.length;
};

const inLayout = (checks: NamedCheck[]) =>
  [...checks].sort(
    (left, right) => sectionIndex(left.section) - sectionIndex(right.section) || rankOf(left) - rankOf(right),
  );

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
    hint === undefined || hint === CIRCULAR_HINT ? [] : [`${style(STYLE.hint, "hint:")} ${shown(hint)}`];

  return [
    `  ${style(STYLE[status], status)}${" ".repeat(STATUS_WIDTH - status.length)}  ${head}`,
    ...[...reasons.map(shown), ...fix].map((line) => `${INDENT}${line}`),
  ];
};

const sectionBlocks = (checks: NamedCheck[], options: ReportOptions) =>
  LAYOUT.map(([section]) =>
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

const countOf = (checks: NamedCheck[], status: CheckStatus) =>
  checks.filter((check) => check.result.status === status).length;

const COUNTS: Array<[CheckStatus, (count: number) => string]> = [
  ["fail", (count) => `${count} failed`],
  ["warn", (count) => `${count} warning${count === 1 ? "" : "s"}`],
  ["ok", (count) => `${count} ok`],
  ["skip", (count) => `${count} skipped`],
];

const verdictOf = (checks: NamedCheck[]) => {
  if (countOf(checks, "fail") > 0) {
    return "fail";
  }

  return countOf(checks, "warn") > 0 ? "ok with warnings" : "ok";
};

const summaryOf = (checks: NamedCheck[]) =>
  COUNTS.map(([status, text]) => [countOf(checks, status), text] as const)
    .filter(([count]) => count > 0)
    .map(([count, text]) => text(count))
    .join(", ");

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
