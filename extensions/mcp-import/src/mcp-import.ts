import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import { errorText, homeRelative } from "../../../core/manager/format.ts";
import { projectSettingsPath, readText, userSettingsPath } from "../../../core/manager/settings.ts";
import type { Host } from "../../../pi-adapter/index.ts";
import {
  completeArgs,
  type ImportArgs,
  MISSING_SOURCE,
  parseArgs,
  type Scope,
  type Source,
  USAGE,
} from "./args.ts";
import { PAIRS, type Pair, pickImport, scanPairs, visibleScope } from "./pick.ts";
import { planImport } from "./plan.ts";
import {
  appliedReport,
  dryRunReport,
  emptyReport,
  NAMESPACE,
  NOT_SELECTED,
  NOTHING_SELECTED,
  nothingToImport,
  pickedReport,
  UNTRUSTED_ONLY,
} from "./report.ts";
import { type Found, findServers } from "./sources.ts";

const MCP_FILE = "mcp.json";

const hasServers = (found: Found) => found.origins.some((origin) => Object.keys(origin.servers).length > 0);

type Prepared = { found: Found; pair?: Pair; problem?: string };

export const createMcpImport = (host: Host, home: string) => {
  const notify = (message: string) => {
    host.ui.notify(message, "info");
  };

  const fail = (message: string, level: "warning" | "error" = "error") => {
    host.ui.notify(`${NAMESPACE}: ${message}`, level);
  };

  const prepare = (source: Source, scope: Scope): Prepared => {
    const { cwd, agentDir } = host.session();
    const found = findServers(source, scope, { home, cwd });

    if (!hasServers(found)) {
      return { found };
    }

    const project = scope === "project";
    const path = project ? projectSettingsPath(cwd, MCP_FILE) : userSettingsPath(agentDir, MCP_FILE);
    const target = project ? `.pi/${MCP_FILE}` : homeRelative(path, home);
    let text: string | undefined;

    try {
      text = readText(path);
    } catch (error) {
      return { found, problem: `cannot read ${path}: ${errorText(error)}` };
    }

    const plan = planImport(source, found.origins, { label: target, text }, { home, sep });

    if (plan.error) {
      return { found, problem: `${plan.error}; fix it first, nothing written` };
    }

    return { found, pair: { source, scope, found, plan, path, target, text } };
  };

  const write = (path: string, text: string | undefined) => {
    if (text === undefined) {
      return true;
    }

    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return true;
    } catch (error) {
      fail(`cannot write ${path}: ${errorText(error)}`);
      return false;
    }
  };

  const run = (args: ImportArgs) => {
    const project = args.scope === "project";

    if (project && args.apply && !host.session().projectTrusted) {
      fail(`trust this project first; pi reads .pi/${MCP_FILE} only in trusted projects`);
      return;
    }

    const { found, pair, problem } = prepare(args.source, args.scope);

    found.problems.forEach((message) => {
      fail(message, "warning");
    });

    if (problem) {
      fail(problem);
      return;
    }

    if (!pair) {
      notify(emptyReport(args, found.checked));
      return;
    }

    const report = { args, plan: pair.plan, checked: found.checked, target: pair.target };

    if (!args.apply) {
      notify(dryRunReport(report));
      return;
    }

    if (write(pair.path, pair.plan.text)) {
      notify(appliedReport(report));
    }
  };

  const apply = (picked: Pair, names: readonly string[]) => {
    const fresh = prepare(picked.source, picked.scope);

    if (fresh.problem) {
      fail(fresh.problem);
      return;
    }

    const pair = fresh.pair;

    if (!pair) {
      fail(`found no MCP servers in ${fresh.found.checked.join(", ")} any more, nothing written`);
      return;
    }

    const chosen = new Set(names);
    const origins = pair.found.origins.map((origin) => ({
      ...origin,
      servers: Object.fromEntries(Object.entries(origin.servers).filter(([name]) => chosen.has(name))),
    }));
    const plan = planImport(pair.source, origins, { label: pair.target, text: pair.text }, { home, sep });
    const unchecked = pair.plan.added
      .filter((entry) => !chosen.has(entry.name))
      .map((entry) => ({ name: entry.name, origin: entry.origin, reason: NOT_SELECTED }));

    if (plan.error) {
      fail(`${plan.error}; fix it first, nothing written`);
      return;
    }

    if (!write(pair.path, plan.text)) {
      return;
    }

    const args = { source: pair.source, scope: pair.scope, apply: true };
    const skipped = [...pair.plan.skipped, ...unchecked];

    notify(
      pickedReport({ args, plan: { ...plan, skipped }, checked: pair.found.checked, target: pair.target }),
    );
  };

  const interactive = async () => {
    const trusted = host.session().projectTrusted;
    const prepared = PAIRS.map(({ source, scope }) => ({ scope, ...prepare(source, scope) }));
    const visible = prepared.filter((item) => visibleScope(item.scope, trusted));
    const warnings = [...new Set(visible.flatMap((item) => item.found.problems))];
    const problems = [...new Set(visible.flatMap((item) => (item.problem ? [item.problem] : [])))];

    warnings.forEach((message) => {
      fail(message, "warning");
    });
    problems.forEach((message) => {
      fail(message);
    });

    const candidates = prepared.flatMap((item) => (item.pair ? [item.pair] : []));
    const scan = scanPairs(candidates, trusted);

    if (scan.kind === "untrusted") {
      fail(UNTRUSTED_ONLY);
      return;
    }

    if (scan.kind === "empty") {
      if (problems.length === 0) {
        notify(nothingToImport([...new Set(visible.flatMap((item) => item.found.checked))], scan));
      }

      return;
    }

    const picked = await pickImport(host, scan.pairs);

    if (!picked) {
      return;
    }

    if (picked.names.length === 0) {
      notify(NOTHING_SELECTED);
      return;
    }

    apply(picked.pair, picked.names);
  };

  host.registerCommand("mcp-import", {
    description: `Import MCP servers from Claude Code or Cursor into pi's mcp.json; without arguments pick the source and servers, with arguments a dry run unless you add apply: ${USAGE}`,
    complete: completeArgs,
    run: async (text) => {
      const args = parseArgs(text);

      if ("error" in args) {
        fail(args.error);
        return;
      }

      if ("interactive" in args) {
        if (host.session().mode !== "tui") {
          fail(MISSING_SOURCE);
          return;
        }

        await interactive();
        return;
      }

      run(args);
    },
  });
};
