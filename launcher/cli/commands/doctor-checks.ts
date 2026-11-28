export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  status: CheckStatus;
  detail: string;
  reasons?: string[];
  hint?: string;
  brief?: string;
  neutral?: boolean;
}

export type Section = "host" | "sandbox" | "network" | "credentials" | "leak sweep";

export interface NamedCheck {
  name: string;
  section: Section;
  result: CheckResult;
  group?: "rules";
  note?: string;
  login?: boolean;
  configured?: boolean;
}

type Explained = Pick<CheckResult, "reasons" | "hint" | "brief">;

type SkipExplained = Explained & Pick<CheckResult, "neutral">;

export const VERBOSE_FLAG = "--verbose";

const LAYOUT: Array<[Section, string[]]> = [
  ["host", ["user config", "pi", "provider hosts", "sessions", "open files", "host side"]],
  [
    "sandbox",
    [
      "vm shares",
      "vm",
      "sandbox",
      "vm size",
      "file cache",
      "image",
      "container",
      "sync",
      "sessions share",
      "sandbox checks",
    ],
  ],
  [
    "network",
    [
      "proxy",
      "proxy health",
      "parent proxy",
      "isolation",
      "tls",
      "tls inspection",
      "tls in sandbox",
      "mcp",
      "blocked",
    ],
  ],
  ["credentials", ["trust", "rule", "mcp", "secrets"]],
  ["leak sweep", ["credential sweep", "mcp-auth sweep", "settings sweep"]],
];

export const SECTIONS = LAYOUT.map(([section]) => section);

const resultOf =
  (status: Exclude<CheckStatus, "skip">) =>
  (detail: string, more: Explained = {}): CheckResult => ({ status, detail, ...more });

export const passed = resultOf("ok");

export const warned = resultOf("warn");

export const failed = resultOf("fail");

export const skipped = (detail: string, more: SkipExplained = {}): CheckResult => ({
  status: "skip",
  detail,
  ...more,
});

export const isNeutral = (result: CheckResult) => result.status === "skip" && result.neutral === true;

const sectionIndex = (section: Section) => LAYOUT.findIndex(([name]) => name === section);

const rankOf = (check: NamedCheck) => {
  const order = LAYOUT[sectionIndex(check.section)]?.[1] ?? [];
  const key = check.group === "rules" ? "rule" : check.name;
  const exact = order.indexOf(key);
  const family = order.indexOf(key.split(" ")[0] ?? "");

  return exact >= 0 ? exact : family >= 0 ? family : order.length;
};

export const inLayout = (checks: NamedCheck[]) =>
  [...checks].sort(
    (left, right) => sectionIndex(left.section) - sectionIndex(right.section) || rankOf(left) - rankOf(right),
  );

const tallyOf = (checks: NamedCheck[]) => {
  const tally: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, skip: 0 };

  checks.forEach((check) => {
    tally[check.result.status] += 1;
  });

  return tally;
};

export const verdictOf = (checks: NamedCheck[]) => {
  const tally = tallyOf(checks);

  return tally.fail > 0 ? "fail" : tally.warn > 0 ? "ok with warnings" : "ok";
};
