import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, sep } from "node:path";
import type { Host } from "../../../core/adapter/contract.ts";
import { errorText, homeRelative } from "../../../core/manager/format.ts";
import { projectSettingsPath, userSettingsPath } from "../../../core/manager/settings.ts";
import { completeArgs, type ImportArgs, parseArgs, USAGE } from "./args.ts";
import { planImport } from "./plan.ts";
import { appliedReport, dryRunReport, emptyReport } from "./report.ts";
import { findServers } from "./sources.ts";

const MCP_FILE = "mcp.json";

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export const createMcpImport = (host: Host, home: string) => {
  const notify = (message: string) => {
    host.ui.notify(message, "info");
  };

  const fail = (message: string, level: "warning" | "error" = "error") => {
    host.ui.notify(`pi-mcp-import: ${message}`, level);
  };

  const run = (args: ImportArgs) => {
    const { cwd, agentDir, projectTrusted } = host.session();
    const project = args.scope === "project";

    if (project && args.apply && !projectTrusted) {
      fail(`trust this project first; pi reads .pi/${MCP_FILE} only in trusted projects`);
      return;
    }

    const found = findServers(args.source, args.scope, { home, cwd });

    found.problems.forEach((problem) => {
      fail(problem, "warning");
    });

    if (found.origins.every((origin) => Object.keys(origin.servers).length === 0)) {
      notify(emptyReport(args, found.checked));
      return;
    }

    const path = project ? projectSettingsPath(cwd, MCP_FILE) : userSettingsPath(agentDir, MCP_FILE);
    const target = project ? `.pi/${MCP_FILE}` : homeRelative(path, home);
    let text: string | undefined;

    try {
      text = readText(path);
    } catch (error) {
      fail(`cannot read ${path}: ${errorText(error)}`);
      return;
    }

    const plan = planImport(args.source, found.origins, { label: target, text }, { home, sep });

    if (plan.error) {
      fail(`${plan.error}; fix it first, nothing written`);
      return;
    }

    const report = { args, plan, checked: found.checked, target };

    if (!args.apply) {
      notify(dryRunReport(report));
      return;
    }

    if (plan.text !== undefined) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, plan.text);
      } catch (error) {
        fail(`cannot write ${path}: ${errorText(error)}`);
        return;
      }
    }

    notify(appliedReport(report));
  };

  host.registerCommand("mcp-import", {
    description: `Import MCP servers from Claude Code or Cursor into pi's mcp.json; a dry run unless you add apply: ${USAGE}`,
    complete: completeArgs,
    run: (text) => {
      const args = parseArgs(text);

      if ("error" in args) {
        fail(args.error);
        return;
      }

      run(args);
    },
  });
};
