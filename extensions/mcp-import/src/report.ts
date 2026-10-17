import type { ImportArgs } from "./args.ts";
import { needsSignIn } from "./convert.ts";
import type { Entry, Plan } from "./plan.ts";

export type ReportInput = { args: ImportArgs; plan: Plan; checked: readonly string[]; target: string };

const command = (args: ImportArgs, apply: boolean) =>
  [
    "/mcp-import",
    args.source,
    ...(args.scope === "project" ? ["project"] : []),
    ...(apply ? ["apply"] : []),
  ].join(" ");

const plural = (count: number) => (count === 1 ? "1 server" : `${count} servers`);

const preview = (entries: readonly Entry[]) =>
  JSON.stringify(
    { mcpServers: Object.fromEntries(entries.map((entry) => [entry.name, entry.server])) },
    null,
    2,
  );

const section = (title: string, lines: readonly string[]) =>
  lines.length > 0 ? ["", `${title}:`, ...lines.map((line) => `  ${line}`)] : [];

const signIn = (entries: readonly Entry[]) =>
  entries.filter((entry) => needsSignIn(entry.server)).map((entry) => entry.name);

const NAMESPACE = "pi-mcp-import";

const detail = ({ plan }: ReportInput) => [
  ...section(
    "notes",
    plan.added.flatMap((entry) => entry.notes.map((note) => `${entry.name}: ${note}`)),
  ),
  ...section(
    "skipped",
    plan.skipped.map((skip) => `${skip.name} (${skip.origin}): ${skip.reason}`),
  ),
];

const oauthLines = (names: readonly string[]) =>
  names.length > 0
    ? [
        `sign in with /mcp (or /mcp login <name>) for ${names.join(", ")} if the server asks; OAuth tokens never transfer from another tool`,
      ]
    : [];

const gap = (lines: readonly string[]) => (lines.length > 0 ? ["", ...lines] : []);

export const dryRunReport = (input: ReportInput) => {
  const { args, plan, checked, target } = input;
  const head = [
    `${NAMESPACE}: dry run of ${command(args, false)}, nothing written`,
    `read: ${checked.join(", ")}`,
    `target: ${target}`,
  ];

  if (plan.added.length === 0) {
    return [...head, "", "nothing to add", ...detail(input)].join("\n");
  }

  return [
    ...head,
    "",
    `would add ${plural(plan.added.length)}:`,
    preview(plan.added),
    ...detail(input),
    ...gap(oauthLines(signIn(plan.added))),
    "",
    `run ${command(args, true)} to write them`,
  ].join("\n");
};

export const appliedReport = (input: ReportInput) => {
  const { args, plan, target } = input;

  if (plan.added.length === 0) {
    return [`${NAMESPACE}: ${command(args, true)} added nothing to ${target}`, ...detail(input)].join("\n");
  }

  return [
    `${NAMESPACE}: ${command(args, true)} added ${plural(plan.added.length)} to ${target}: ${plan.added.map((entry) => entry.name).join(", ")}`,
    ...detail(input),
    "",
    "run /reload to connect them, then /mcp to check them",
    ...oauthLines(signIn(plan.added)),
  ].join("\n");
};

export const emptyReport = (args: ImportArgs, checked: readonly string[]) =>
  `${NAMESPACE}: ${command(args, false)} found no MCP servers in ${checked.join(", ")}`;
