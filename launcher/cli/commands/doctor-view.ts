import {
  type CheckResult,
  inLayout,
  isNeutral,
  type NamedCheck,
  passed,
  type Section,
  VERBOSE_FLAG,
} from "./doctor-checks.ts";

type Briefs = (name: string) => string | undefined;

interface Group {
  name: string;
  section: Section;
  members: string[];
  detail: (brief: Briefs, has: (name: string) => boolean) => string | undefined;
}

const HIDDEN_WHEN_OK = new Set(["provider hosts", "host side", "file cache", "proxy", "proxy health", "mcp"]);

const joined = (separator: string, parts: Array<string | undefined>) =>
  parts.filter((part) => part !== undefined && part !== "").join(separator);

const GROUPS: Group[] = [
  {
    name: "sessions",
    section: "host",
    members: ["sessions", "sessions share"],
    detail: (brief) => joined(", ", [brief("sessions"), brief("sessions share")]),
  },
  {
    name: "vm",
    section: "sandbox",
    members: ["vm shares", "vm", "vm size"],
    detail: (brief, has) =>
      joined(", ", [has("vm") ? "running" : undefined, brief("vm size"), brief("vm shares")]),
  },
  {
    name: "sandbox",
    section: "sandbox",
    members: ["image", "container", "sync"],
    detail: (brief, has) => (has("container") ? `starts here (${brief("image") || "its image"})` : undefined),
  },
  {
    name: "tls",
    section: "network",
    members: ["tls inspection", "tls in sandbox", "trust"],
    detail: (brief, has) =>
      joined("; ", [
        brief("tls inspection"),
        has("tls in sandbox") ? "the sandbox trusts HTTPS through the proxy" : undefined,
      ]),
  },
  {
    name: "secrets",
    section: "credentials",
    members: ["credential sweep", "mcp-auth sweep", "settings sweep"],
    detail: (brief) => joined("; ", ["no real credential inside the sandbox", brief("credential sweep")]),
  },
];

const isQuiet = (result: CheckResult) => result.status === "ok" || isNeutral(result);

const hasReasons = (result: CheckResult) => (result.reasons ?? []).length > 0;

const isRule = (check: NamedCheck) => check.group === "rules";

const isPassingRule = (check: NamedCheck) => isRule(check) && check.result.status === "ok";

const rulesSummary = (passing: NamedCheck[], others: boolean): NamedCheck => {
  const logins = passing.every((check) => check.login === true);
  const noun = logins ? "login" : "credential rule";

  return {
    name: logins ? "logins" : "credential hosts",
    section: "credentials",
    result: passed(
      `${passing.length} ${others ? "other " : ""}${noun}${passing.length === 1 ? "" : "s"} answered through the proxy (${VERBOSE_FLAG} lists them)`,
    ),
  };
};

const collapsed = (checks: NamedCheck[]) => {
  const passing = checks.filter(isPassingRule);

  if (passing.length === 0) {
    return checks;
  }

  const last = checks.findLastIndex(isRule);
  const others = checks.some((check) => isRule(check) && !isPassingRule(check));

  return checks.flatMap((check, index) => [
    ...(isPassingRule(check) ? [] : [check]),
    ...(index === last ? [rulesSummary(passing, others)] : []),
  ]);
};

const mergedRow = (group: Group, members: NamedCheck[]): NamedCheck[] | undefined => {
  if (members.length === 0 || !members.every((member) => isQuiet(member.result))) {
    return undefined;
  }

  const ok = members.filter((member) => member.result.status === "ok");
  const brief = (name: string) => ok.find((member) => member.name === name)?.result.brief;
  const has = (name: string) => ok.some((member) => member.name === name);
  const detail = group.detail(brief, has);

  if (detail === undefined || detail === "") {
    return undefined;
  }

  const reasons = members.flatMap((member) => member.result.reasons ?? []);

  return [
    {
      name: group.name,
      section: group.section,
      result: passed(detail, reasons.length === 0 ? {} : { reasons }),
    },
  ];
};

const grouped = (checks: NamedCheck[]) =>
  GROUPS.reduce((rows, group) => {
    const isMember = (check: NamedCheck) => check.group === undefined && group.members.includes(check.name);
    const merged = mergedRow(group, rows.filter(isMember));

    return merged === undefined
      ? rows.filter((check) => !isMember(check) || !isQuiet(check.result) || hasReasons(check.result))
      : [...rows.filter((check) => !isMember(check)), ...merged];
  }, checks);

const isHiddenWhenOk = (check: NamedCheck) => check.group === undefined && HIDDEN_WHEN_OK.has(check.name);

const isShown = (check: NamedCheck) => {
  if (isNeutral(check.result)) {
    return hasReasons(check.result);
  }

  if (check.result.status !== "ok" || !isHiddenWhenOk(check)) {
    return true;
  }

  return check.result.brief !== undefined || hasReasons(check.result);
};

const shownByDefault = (check: NamedCheck): NamedCheck => {
  const moved: NamedCheck = check.section === "leak sweep" ? { ...check, section: "credentials" } : check;
  const { brief } = check.result;

  return isHiddenWhenOk(check) && check.name === "mcp" && check.result.status === "ok" && brief !== undefined
    ? { ...moved, result: { ...moved.result, detail: brief } }
    : moved;
};

const withNote = (check: NamedCheck): NamedCheck =>
  check.note === undefined
    ? check
    : {
        ...check,
        result: { ...check.result, detail: joined(" ", [check.result.detail, `(${check.note})`]) },
      };

export const verboseRows = (checks: NamedCheck[]) => inLayout(checks).map(withNote);

const withFailedRuleNote = (check: NamedCheck) =>
  isRule(check) && check.configured === true && check.result.status !== "ok" ? withNote(check) : check;

export const defaultRows = (checks: NamedCheck[]) =>
  collapsed(inLayout(grouped(checks).filter(isShown).map(shownByDefault))).map(withFailedRuleNote);
