import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Host } from "../../../core/adapter/contract.ts";
import { errorText } from "../../../core/manager/format.ts";
import { completeArgs, type ImportArgs, parseArgs, USAGE } from "./args.ts";
import { planImport } from "./plan.ts";
import { appliedReport, dryRunReport, emptyReport } from "./report.ts";
import { findServers } from "./sources.ts";

export const MCP_FILE = "mcp.json";

const display = (path: string, home: string) => (path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path);

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export const createMcpImport = (host: Host, home: string) => {
  const notify = (message: string, level: "info" | "warning" | "error" = "info") => {
    host.ui.notify(message, level);
  };

  const run = (args: ImportArgs) => {
    const { cwd, agentDir, projectTrusted } = host.session();
    const project = args.scope === "project";

    if (project && args.apply && !projectTrusted) {
      notify("/mcp-import: trust this project first; pi reads .pi/mcp.json only in trusted projects.", "error");
      return;
    }

    const found = findServers(args.source, args.scope, { home, cwd });

    found.problems.forEach((problem) => {
      notify(`/mcp-import: ${problem}`, "warning");
    });

    if (found.origins.every((origin) => Object.keys(origin.servers).length === 0)) {
      notify(emptyReport(args, found.checked));
      return;
    }

    const path = project ? join(cwd, ".pi", MCP_FILE) : join(agentDir, MCP_FILE);
    const target = project ? `.pi/${MCP_FILE}` : display(path, home);
    let text: string | undefined;

    try {
      text = readText(path);
    } catch (error) {
      notify(`/mcp-import: cannot read ${path}: ${errorText(error)}`, "error");
      return;
    }

    const plan = planImport(args.source, found.origins, { label: target, text }, { home, sep });

    if (plan.error) {
      notify(`/mcp-import: ${plan.error}; fix it first, nothing written.`, "error");
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
        notify(`/mcp-import: cannot write ${path}: ${errorText(error)}`, "error");
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

      if (typeof args === "string") {
        notify(args, "error");
        return;
      }

      run(args);
    },
  });
};
