import { counted } from "../../../shared/index.ts";
import type { ImportArgs } from "./args.ts";
import { needsSignIn } from "./convert.ts";
import type { Entry, Plan, Skipped } from "./plan.ts";

type ReportInput = { args: ImportArgs; plan: Plan; checked: readonly string[]; target: string };

const command = (args: ImportArgs, apply: boolean) =>
  [
    "/mcp-import",
    args.source,
    ...(args.scope === "project" ? ["project"] : []),
    ...(apply ? ["apply"] : []),
  ].join(" ");

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

export const NAMESPACE = "pi-mcp-import";

const skippedSection = (skipped: readonly Skipped[]) =>
  section(
    "skipped",
    skipped.map((skip) => `${skip.name} (${skip.origin}): ${skip.reason}`),
  );

const detail = ({ plan }: ReportInput) => [
  ...section(
    "notes",
    plan.added.flatMap((entry) => entry.notes.map((note) => `${entry.name}: ${note}`)),
  ),
  ...skippedSection(plan.skipped),
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
    `would add ${counted(plan.added.length, "server")}:`,
    preview(plan.added),
    ...detail(input),
    ...gap(oauthLines(signIn(plan.added))),
    "",
    `run ${command(args, true)} to write them`,
  ].join("\n");
};

const addedReport = (subject: string, input: ReportInput) => {
  const { plan, target } = input;

  if (plan.added.length === 0) {
    return [`${subject} added nothing to ${target}`, ...detail(input)].join("\n");
  }

  return [
    `${subject} added ${counted(plan.added.length, "server")} to ${target}: ${plan.added.map((entry) => entry.name).join(", ")}`,
    ...detail(input),
    "",
    "run /reload to connect them, then /mcp to check them",
    ...oauthLines(signIn(plan.added)),
  ].join("\n");
};

export const appliedReport = (input: ReportInput) =>
  addedReport(`${NAMESPACE}: ${command(input.args, true)}`, input);

export const pickedReport = (input: ReportInput) => addedReport(`${NAMESPACE}:`, input);

export const NOT_SELECTED = "not selected";

export const NOTHING_SELECTED = `${NAMESPACE}: nothing selected, nothing written`;

export const UNTRUSTED_ONLY =
  "found MCP servers only in this project's files; trust this project first, pi reads .pi/mcp.json only in trusted projects";

type Nothing = {
  files: readonly string[];
  targets: readonly string[];
  skipped: readonly Skipped[];
  present: boolean;
};

export const nothingToImport = (
  checked: readonly string[],
  { files, targets, skipped, present }: Nothing,
) => {
  if (files.length === 0) {
    return `${NAMESPACE}: found no MCP servers to import in ${checked.join(", ")}`;
  }

  if (present) {
    return `${NAMESPACE}: nothing new to import: every server in ${files.join(", ")} is already in ${targets.join(", ")}`;
  }

  return [`${NAMESPACE}: nothing to import from ${files.join(", ")}`, ...skippedSection(skipped)].join("\n");
};

export const emptyReport = (args: ImportArgs, checked: readonly string[]) =>
  `${NAMESPACE}: ${command(args, false)} found no MCP servers in ${checked.join(", ")}`;
