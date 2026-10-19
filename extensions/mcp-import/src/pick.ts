import type { Host } from "../../../core/adapter/contract.ts";
import { multiSelectForm } from "../../../core/manager/multi-select.ts";
import { selectForm } from "../../../core/manager/select.ts";
import type { Scope, Source } from "./args.ts";
import { needsSignIn } from "./convert.ts";
import type { Entry, Plan, Skipped } from "./plan.ts";
import type { Found } from "./sources.ts";

export type Pair = {
  source: Source;
  scope: Scope;
  found: Found;
  plan: Plan;
  path: string;
  target: string;
  text?: string;
};

export type Scan =
  | { kind: "pairs"; pairs: Pair[] }
  | { kind: "untrusted" }
  | { kind: "empty"; files: string[]; targets: string[]; skipped: Skipped[]; present: boolean };

export const PAIRS: readonly { source: Source; scope: Scope }[] = [
  { source: "claude", scope: "user" },
  { source: "claude", scope: "project" },
  { source: "cursor", scope: "user" },
  { source: "cursor", scope: "project" },
];

const SOURCE_NAMES: Record<Source, string> = { claude: "Claude Code", cursor: "Cursor" };

const SCOPE_NAMES: Record<Scope, string> = { user: "user", project: "this project" };

const NAMES_ROOM = 40;

const foundNames = (pair: Pair) => [
  ...new Set(pair.found.origins.flatMap((origin) => Object.keys(origin.servers))),
];

const allPresent = (pair: Pair) => {
  const present = new Set(pair.plan.skipped.filter((skip) => skip.present).map((skip) => skip.name));

  return foundNames(pair).every((name) => present.has(name));
};

export const visibleScope = (scope: Scope, trusted: boolean) => trusted || scope === "user";

export const scanPairs = (candidates: readonly Pair[], trusted: boolean): Scan => {
  const addable = candidates.filter((pair) => pair.plan.added.length > 0);
  const pairs = addable.filter((pair) => visibleScope(pair.scope, trusted));

  if (pairs.length > 0) {
    return { kind: "pairs", pairs };
  }

  if (addable.length > 0) {
    return { kind: "untrusted" };
  }

  const withServers = candidates.filter(
    (pair) => visibleScope(pair.scope, trusted) && foundNames(pair).length > 0,
  );
  const files = withServers.flatMap((pair) =>
    pair.found.origins
      .filter((origin) => Object.keys(origin.servers).length > 0)
      .map((origin) => origin.label),
  );

  return {
    kind: "empty",
    files: [...new Set(files)],
    targets: [...new Set(withServers.map((pair) => pair.target))],
    skipped: withServers.flatMap((pair) => pair.plan.skipped),
    present: withServers.length > 0 && withServers.every(allPresent),
  };
};

const nameList = (names: readonly string[]) => {
  const over = names.findIndex((_, index) => names.slice(0, index + 1).join(", ").length > NAMES_ROOM);
  const shown = names.slice(0, over === -1 ? names.length : over);
  const rest = shown.length < names.length ? (shown.length > 0 ? ", …" : "…") : "";

  return `${shown.join(", ")}${rest}`;
};

export const pairLabel = (pair: Pick<Pair, "source" | "scope">) =>
  `${SOURCE_NAMES[pair.source]} · ${SCOPE_NAMES[pair.scope]}`;

export const sourceOptions = (pairs: readonly Pair[]) =>
  pairs.map((pair) => {
    const names = pair.plan.added.map((entry) => entry.name);

    return {
      label: pairLabel(pair),
      description: `${names.length} new: ${nameList(names)} → ${pair.target}`,
      value: pair,
    };
  });

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const transport = ({ server }: Entry) =>
  typeof server.url === "string"
    ? `http · ${server.url}`
    : `stdio · ${[server.command, ...strings(server.args)].filter((part) => typeof part === "string").join(" ")}`;

const serverDescription = (entry: Entry) => {
  const notes = entry.notes.length;
  const parts = [
    transport(entry),
    ...(needsSignIn(entry.server) ? ["needs sign-in"] : []),
    ...(notes > 0 ? [notes === 1 ? "1 note" : `${notes} notes`] : []),
  ];

  return parts.join(" · ");
};

export const serverOptions = (plan: Plan) =>
  plan.added.map((entry) => ({
    label: entry.name,
    description: serverDescription(entry),
    value: entry.name,
  }));

export const pickImport = async (host: Host, pairs: readonly Pair[]) => {
  const pair =
    pairs.length === 1
      ? pairs[0]
      : await host.ui.showForm(
          selectForm({ title: "Import MCP servers from", options: sourceOptions(pairs) }),
        );

  if (!pair) {
    return undefined;
  }

  const options = serverOptions(pair.plan);
  const names = await host.ui.showForm(
    multiSelectForm({
      title: `Servers to add to ${pair.target}`,
      options,
      checked: options.map(() => true),
      submitHint: "add",
    }),
  );

  return names ? { pair, names } : undefined;
};
