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

const detail = ({ plan }: ReportInput) => [
  ...section(
    "Notes",
    plan.added.flatMap((entry) => entry.notes.map((note) => `${entry.name}: ${note}`)),
  ),
  ...section(
    "Skipped",
    plan.skipped.map((skip) => `${skip.name} (${skip.origin}): ${skip.reason}`),
  ),
];

const oauthLine = (names: readonly string[]) =>
  names.length > 0
    ? [
        "",
        `Sign in with /mcp (or /mcp login <name>) for ${names.join(", ")} if the server asks: OAuth tokens never transfer from another tool.`,
      ]
    : [];

export const dryRunReport = (input: ReportInput) => {
  const { args, plan, checked, target } = input;
  const head = [
    `${command(args, false)}: dry run, nothing written.`,
    `Read: ${checked.join(", ")}`,
    `Target: ${target}`,
  ];

  if (plan.added.length === 0) {
    return [...head, "", "Nothing to add.", ...detail(input)].join("\n");
  }

  return [
    ...head,
    "",
    `Would add ${plural(plan.added.length)}:`,
    preview(plan.added),
    ...detail(input),
    ...oauthLine(signIn(plan.added)),
    "",
    `Run ${command(args, true)} to write them.`,
  ].join("\n");
};

export const appliedReport = (input: ReportInput) => {
  const { args, plan, target } = input;

  if (plan.added.length === 0) {
    return [`${command(args, true)}: nothing added to ${target}.`, ...detail(input)].join("\n");
  }

  return [
    `${command(args, true)}: added ${plural(plan.added.length)} to ${target}: ${plan.added.map((entry) => entry.name).join(", ")}.`,
    ...detail(input),
    "",
    "Run /reload to connect them, then /mcp to check them.",
    ...oauthLine(signIn(plan.added)).slice(1),
  ].join("\n");
};

export const emptyReport = (args: ImportArgs, checked: readonly string[]) =>
  `${command(args, false)}: no MCP servers found in ${checked.join(", ")}.`;
