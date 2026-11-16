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

type Explained = Pick<CheckResult, "reasons" | "hint">;

export const VERBOSE_FLAG = "--verbose";

const LAYOUT: Array<[Section, string[]]> = [
  ["host", ["user config", "old state", "host pi", "provider hosts", "sessions", "host side"]],
  [
    "sandbox",
    ["vm shares", "vm", "sandbox", "vm size", "image", "container", "sync", "sessions share", "probes"],
  ],
  [
    "network",
    [
      "proxy",
      "proxy health",
      "parent proxy",
      "tls inspection",
      "tls in sandbox",
      "no-route",
      "mcp",
      "blocked",
    ],
  ],
  ["credentials", ["trust", "rule", "mcp"]],
  ["leak sweep", ["credential sweep", "mcp-auth sweep", "settings sweep"]],
];

export const SECTIONS = LAYOUT.map(([section]) => section);

const resultOf =
  (status: CheckStatus) =>
  (detail: string, more: Explained = {}): CheckResult => ({ status, detail, ...more });

export const passed = resultOf("ok");

export const warned = resultOf("warn");

export const failed = resultOf("fail");

export const skipped = resultOf("skip");

const sectionIndex = (section: Section) => LAYOUT.findIndex(([name]) => name === section);

const rankOf = (check: NamedCheck) => {
  const order = LAYOUT[sectionIndex(check.section)]?.[1] ?? [];
  const exact = order.indexOf(check.name);
  const family = order.indexOf(check.name.split(" ")[0] ?? "");

  return exact >= 0 ? exact : family >= 0 ? family : order.length;
};

export const inLayout = (checks: NamedCheck[]) =>
  [...checks].sort(
    (left, right) => sectionIndex(left.section) - sectionIndex(right.section) || rankOf(left) - rankOf(right),
  );

export const tallyOf = (checks: NamedCheck[]) => {
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
