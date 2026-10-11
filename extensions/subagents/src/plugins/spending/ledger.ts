import { addUsage, emptyUsage, subtractUsage, type UsageTotals } from "../../adapter/contract.ts";
import type { SpendLedger } from "../../manager/types.ts";

export const SPEND_ENTRY = "pi-subagents:spend";

export const DELIVERED_ENTRY = "pi-subagents:delivered";

export type SpendEntry = { agentId: string; usage: UsageTotals };

export type DeliveredEntry = { agents: Record<string, UsageTotals> };

export type LedgerStore = {
  append(customType: string, data: unknown): void;
  read<T>(customType: string): T[];
};

const isAhead = (candidate: UsageTotals, current: UsageTotals | undefined) => {
  if (!current) {
    return true;
  }

  return candidate.cost.total > current.cost.total || candidate.totalTokens > current.totalTokens;
};

const isPositive = (usage: UsageTotals) => usage.cost.total > 0 || usage.totalTokens > 0;

type UsageCollection = { forEach(visit: (usage: UsageTotals) => void): void };

const sum = (usages: UsageCollection) => {
  let total = emptyUsage();

  usages.forEach((usage) => {
    total = addUsage(total, usage);
  });

  return total;
};

export const createLedger = (
  store: LedgerStore,
  onChange: (agentId: string) => void = () => {},
): SpendLedger => {
  const current = new Map<string, UsageTotals>();
  const delivered = new Map<string, UsageTotals>();
  const persisted = new Map<string, number>();

  const keepHighest = (map: Map<string, UsageTotals>, agentId: string, usage: UsageTotals) => {
    if (!isAhead(usage, map.get(agentId))) {
      return false;
    }

    map.set(agentId, usage);

    return true;
  };

  const record = (agentId: string, usage: UsageTotals) => {
    if (keepHighest(current, agentId, usage)) {
      onChange(agentId);
    }
  };

  const persist = (agentId: string) => {
    const usage = current.get(agentId);

    if (!usage || persisted.get(agentId) === usage.totalTokens) {
      return;
    }

    persisted.set(agentId, usage.totalTokens);
    store.append(SPEND_ENTRY, { agentId, usage } satisfies SpendEntry);
  };

  const takeUndelivered = () => {
    const pending = Array.from(current, ([agentId, usage]) => ({
      agentId,
      usage,
      owed: subtractUsage(usage, delivered.get(agentId) ?? emptyUsage()),
    })).filter((entry) => isPositive(entry.owed));

    if (pending.length === 0) {
      return undefined;
    }

    pending.forEach((entry) => {
      delivered.set(entry.agentId, entry.usage);
    });

    store.append(DELIVERED_ENTRY, {
      agents: Object.fromEntries(pending.map((entry) => [entry.agentId, entry.usage])),
    } satisfies DeliveredEntry);

    return sum(pending.map((entry) => entry.owed));
  };

  const restore = () => {
    store.read<SpendEntry>(SPEND_ENTRY).forEach((entry) => {
      keepHighest(current, entry.agentId, entry.usage);
      persisted.set(entry.agentId, Math.max(persisted.get(entry.agentId) ?? 0, entry.usage.totalTokens));
    });

    store.read<DeliveredEntry>(DELIVERED_ENTRY).forEach((entry) => {
      Object.entries(entry.agents).forEach(([agentId, usage]) => {
        keepHighest(delivered, agentId, usage);
        keepHighest(current, agentId, usage);
      });
    });
  };

  return {
    record,
    persist,
    agentsTotal: () => sum(current),
    deliveredTotal: () => sum(delivered),
    takeUndelivered,
    restore,
  };
};
