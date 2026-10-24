import type { Host } from "../../../core/adapter/contract.ts";
import { homeRelative } from "../../../core/manager/format.ts";
import { EXPAND_BINDING } from "../../../core/manager/hints.ts";
import { type Breakdown, breakdownOf } from "./buckets.ts";
import { renderSnapshot } from "./render.ts";
import { parseSnapshot, type Snapshot } from "./snapshot.ts";
import { summaryLine } from "./summary.ts";

export const SNAPSHOT_ENTRY = "pi-context:snapshot";

const ALL = "all";

type ContextEnv = { home: string; now(): number };

const cwdOrHomeRelative = (path: string, home: string, cwd: string) => {
  if (cwd && path.startsWith(`${cwd}/`)) {
    return `./${path.slice(cwd.length + 1)}`;
  }

  return homeRelative(path, home);
};

const shortened = (breakdown: Breakdown, home: string, cwd: string): Breakdown => ({
  ...breakdown,
  memoryFiles: breakdown.memoryFiles.map((part) => ({
    ...part,
    name: cwdOrHomeRelative(part.name, home, cwd),
  })),
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
      const facts = host.contextFacts();

      if (!facts) {
        host.ui.notify("No live session to measure.", "warning");
        return;
      }

      const info = host.session();
      const snapshot: Snapshot = {
        breakdown: shortened(breakdownOf(facts), env.home, info.cwd),
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
