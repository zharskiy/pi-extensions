import type { ContextBreakdown, Host } from "../../../core/adapter/contract.ts";
import { parseSnapshot, type Snapshot, shortPath } from "./breakdown.ts";
import { renderSnapshot, summaryLine } from "./render.ts";

export const SNAPSHOT_ENTRY = "pi-context:snapshot";

const EXPAND_BINDING = "app.tools.expand";

const ALL = "all";

export type ContextEnv = { home: string; now(): number };

const shortened = (breakdown: ContextBreakdown, home: string, cwd: string): ContextBreakdown => ({
  ...breakdown,
  memoryFiles: breakdown.memoryFiles.map((part) => ({ ...part, name: shortPath(part.name, home, cwd) })),
});

export const createContext = (host: Host, env: ContextEnv) => {
  host.registerEntryRenderer(SNAPSHOT_ENTRY, (data, width, expanded, theme) => {
    const snapshot = parseSnapshot(data);

    if (!snapshot) {
      return [];
    }

    return renderSnapshot(theme, snapshot, { width, expanded, expandKey: host.ui.keyText(EXPAND_BINDING) });
  });

  host.registerCommand("context", {
    description: "Show what fills the context window, with cache hits (all: expanded)",
    complete: (prefix) => (ALL.startsWith(prefix.trim()) ? [{ value: ALL, label: ALL }] : null),
    run: (args) => {
      const breakdown = host.contextBreakdown();

      if (!breakdown) {
        host.ui.notify("No live session to measure.", "warning");
        return;
      }

      const info = host.session();
      const snapshot: Snapshot = {
        breakdown: shortened(breakdown, env.home, info.cwd),
        lastRequest: host.lastRequestUsage(),
        session: host.mainRequestUsage(),
        timestamp: env.now(),
        expandedByDefault: args.trim() === ALL,
      };

      if (info.mode !== "tui") {
        host.ui.notify(summaryLine(snapshot));
        return;
      }

      host.appendEntry(SNAPSHOT_ENTRY, snapshot);
    },
  });
};
