import { describe, expect, it } from "vitest";
import { addUsage } from "../../../src/adapter/contract.ts";
import { sumOwnUsage, sumSessionUsage } from "../../../src/adapter/usage.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { type AgentStatusParams, agentStatusPlugin } from "../../../src/plugins/agent-status/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { footerText } from "../../../src/plugins/spending/footer.ts";
import { STATUS_KEY, spendingPlugin } from "../../../src/plugins/spending/index.ts";
import { createLedger, DELIVERED_ENTRY, SPEND_ENTRY } from "../../../src/plugins/spending/ledger.ts";
import { flush, usageOf } from "../../helpers/fakes.ts";
import { createHarness } from "../../helpers/harness.ts";

const memoryStore = () => {
  const entries: { customType: string; data: unknown }[] = [];

  return {
    entries,
    append: (customType: string, data: unknown) => {
      entries.push({ customType, data: structuredClone(data) });
    },
    read: <T>(customType: string) =>
      entries.filter((entry) => entry.customType === customType).map((entry) => entry.data as T),
  };
};

const allPlugins = [
  spendingPlugin,
  agentRegistryPlugin,
  agentDefinitionsPlugin,
  runAgentPlugin,
  agentStatusPlugin,
];

describe("spend ledger", () => {
  it("keeps a high-water mark per agent so repeated or stale reports never double count", () => {
    const ledger = createLedger(memoryStore());

    ledger.record("a", usageOf(0.1));
    ledger.record("a", usageOf(0.3));
    ledger.record("a", usageOf(0.2));
    ledger.record("b", usageOf(0.05));

    expect(ledger.agentsTotal().cost.total).toBeCloseTo(0.35);
  });

  it("delivers not-yet-reported usage exactly once", () => {
    const ledger = createLedger(memoryStore());

    ledger.record("a", usageOf(0.1));

    expect(ledger.takeUndelivered()?.cost.total).toBeCloseTo(0.1);
    expect(ledger.takeUndelivered()).toBeUndefined();

    ledger.record("a", usageOf(0.25));

    expect(ledger.takeUndelivered()?.cost.total).toBeCloseTo(0.15);
    expect(ledger.deliveredTotal().cost.total).toBeCloseTo(0.25);
  });

  it("restores totals and deliveries after a reload without double counting", () => {
    const store = memoryStore();
    const before = createLedger(store);

    before.record("a", usageOf(0.2));
    before.persist("a");
    before.persist("a");
    before.record("b", usageOf(0.1));
    before.takeUndelivered();
    before.record("b", usageOf(0.15));
    before.persist("b");

    expect(store.read(SPEND_ENTRY)).toHaveLength(2);
    expect(store.read(DELIVERED_ENTRY)).toHaveLength(1);

    const after = createLedger(store);

    after.restore();
    after.restore();

    expect(after.agentsTotal().cost.total).toBeCloseTo(0.35);
    expect(after.deliveredTotal().cost.total).toBeCloseTo(0.3);
    expect(after.takeUndelivered()?.cost.total).toBeCloseTo(0.05);
  });
});

describe("nested usage", () => {
  it("counts a child's own usage only, so usage delivered from its children is counted once", () => {
    const childOwn = usageOf(0.2);
    const grandchild = usageOf(0.5);

    const childEntries = [
      { type: "message", message: { role: "assistant", usage: childOwn } },
      { type: "message", message: { role: "toolResult", usage: grandchild } },
      { type: "usage", usage: usageOf(0.01) },
    ];

    expect(sumSessionUsage(childEntries).cost.total).toBeCloseTo(0.71);
    expect(sumOwnUsage(childEntries).cost.total).toBeCloseTo(0.21);

    const ledger = createLedger(memoryStore());

    ledger.record("child", sumOwnUsage(childEntries));
    ledger.record("grandchild", grandchild);

    expect(ledger.agentsTotal().cost.total).toBeCloseTo(0.71);
  });
});

describe("spending plugin", () => {
  it("shows main, agents and total in the footer and keeps pi's total equal to main plus delivered usage", async () => {
    const harness = createHarness(allPlugins);
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");
    const status = harness.host.tool<AgentStatusParams, unknown>("agent_status");

    harness.host.usage = usageOf(1);

    await runAgent.execute({ agents: [{ agent: "explorer", task: "x" }] }, { update: () => {} });
    await flush();

    const child = harness.runtime.children[0];

    child.usage = usageOf(0.4);
    child.turn({ tokens: 1_000 });
    harness.host.settle();
    child.usage = usageOf(0.5);
    child.finish("result");
    await flush();

    expect(harness.host.statuses.get(STATUS_KEY)).toBe("main $1.000 · agents $0.500 · total $1.500");

    const delivered = await status.execute({}, { update: () => {} });

    expect(delivered.usage?.cost.total).toBeCloseTo(0.5);

    harness.host.usage = addUsage(harness.host.usage, delivered.usage ?? usageOf(0));
    harness.host.settle();

    expect(harness.host.statuses.get(STATUS_KEY)).toBe("main $1.000 · agents $0.500 · total $1.500");

    const piTotal = harness.host.usage.cost.total;
    const ledger = harness.services.require("ledger");
    const ourMain = piTotal - ledger.deliveredTotal().cost.total;

    expect(piTotal).toBeCloseTo(ourMain + ledger.deliveredTotal().cost.total);
    expect(harness.host.entries.filter((entry) => entry.customType === SPEND_ENTRY)).toHaveLength(1);
  });

  it("keeps totals across a reload", async () => {
    const harness = createHarness(allPlugins);
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");

    await runAgent.execute({ agents: [{ agent: "explorer", task: "x" }] }, { update: () => {} });
    await flush();
    harness.host.settle();

    const child = harness.runtime.children[0];

    child.usage = usageOf(0.3);
    child.finish("result");
    await flush();

    const reloaded = createHarness(allPlugins);

    reloaded.host.entries.push(...harness.host.entries);
    reloaded.host.start();

    expect(reloaded.services.require("ledger").agentsTotal().cost.total).toBeCloseTo(0.3);
    expect(reloaded.host.statuses.get(STATUS_KEY)).toContain("agents $0.300");
  });

  it("labels subscription spend the way pi does", () => {
    expect(footerText({ main: 0.1, agents: 0.2, subscription: true })).toBe(
      "main $0.100 · agents $0.200 · total $0.300 (sub)",
    );
  });
});
