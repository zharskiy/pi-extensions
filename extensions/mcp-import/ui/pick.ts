import type { Host } from "../../../pi-adapter/index.ts";
import { counted, DOT, ELLIPSIS } from "../../../shared/index.ts";
import { multiSelectForm, selectForm } from "../../../ui-kit/index.ts";
import type { Scope, Source } from "../core/args.ts";
import { needsSignIn } from "../core/convert.ts";
import type { Pair } from "../core/import-flow.ts";
import type { Entry, Plan } from "../core/plan.ts";

const SOURCE_NAMES: Record<Source, string> = { claude: "Claude Code", cursor: "Cursor" };

const SCOPE_NAMES: Record<Scope, string> = { user: "user", project: "this project" };

const NAMES_ROOM = 40;

const nameList = (names: readonly string[]) => {
  const over = names.findIndex((_, index) => names.slice(0, index + 1).join(", ").length > NAMES_ROOM);
  const shown = names.slice(0, over === -1 ? names.length : over);
  const rest = shown.length < names.length ? (shown.length > 0 ? `, ${ELLIPSIS}` : ELLIPSIS) : "";

  return `${shown.join(", ")}${rest}`;
};

const pairLabel = (pair: Pick<Pair, "source" | "scope">) =>
  `${SOURCE_NAMES[pair.source]} · ${SCOPE_NAMES[pair.scope]}`;

const sourceOptions = (pairs: readonly Pair[]) =>
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
    ? `http${DOT}${server.url}`
    : `stdio${DOT}${[server.command, ...strings(server.args)].filter((part) => typeof part === "string").join(" ")}`;

const serverDescription = (entry: Entry) => {
  const notes = entry.notes.length;
  const parts = [
    transport(entry),
    ...(needsSignIn(entry.server) ? ["needs sign-in"] : []),
    ...(notes > 0 ? [counted(notes, "note")] : []),
  ];

  return parts.join(DOT);
};

const serverOptions = (plan: Plan) =>
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
