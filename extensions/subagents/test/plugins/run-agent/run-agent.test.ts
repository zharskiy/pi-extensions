import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentStatusPlugin } from "../../../src/plugins/agent-status/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { createOutbox, joinTexts, type OutboxItem } from "../../../src/plugins/run-agent/outbox.ts";
import type { Runner } from "../../../src/plugins/run-agent/runner.ts";
import { createSemaphore } from "../../../src/plugins/run-agent/semaphore.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness, PACKAGE_ROOT, wakeTexts } from "../../helpers/harness.ts";

const setup = (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], overrides);
  const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");
  const registry = harness.services.require("registry");

  const run = async (agents: RunAgentParams["agents"], wait = false) => {
    harness.host.idle = false;

    const result = await runAgent.execute({ agents, wait }, { update: () => {} });

    await flush();

    return result;
  };

  return { ...harness, run, registry };
};

const tasks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ agent: "explorer", task: `task ${index}` }));

describe("run_agent batches", () => {
  it("starts agents in the background and wakes the caller once when all three are done", async () => {
    const { run, runtime, host, registry } = setup();
    const result = await run(tasks(3));

    expect(result.text).toContain("Started batch");
    expect(result.details?.agents).toHaveLength(3);
    expect(runtime.children).toHaveLength(3);

    host.settle();

    runtime.children[0].finish("first result");
    runtime.children[1].finish("second result");

    expect(wakeTexts(host)).toEqual([]);

    runtime.children[2].finish("third result");

    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("finished: 3 done");
    expect(wakeTexts(host)[0]).toContain("first result");
    expect(wakeTexts(host)[0]).toContain("third result");
    expect(host.hidden[0]).toMatchObject({
      message: { customType: "pi-subagents:wake" },
      visible: "↳ 3 agents finished",
      delivery: "nextTurn",
    });
    expect(host.sent).toEqual([]);
    expect(registry.list().every((record) => record.state === "done")).toBe(true);

    await flush();

    expect(runtime.children.every((child) => child.disposed)).toBe(true);
  });

  it("still wakes once when one agent fails, with the failure marked", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(3));
    host.settle();

    runtime.children[0].finish("ok one");
    runtime.children[1].finish("", { stopReason: "error", error: "rate limited" });
    runtime.children[2].finish("ok three");

    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("2 done, 1 failed");
    expect(wakeTexts(host)[0]).toMatch(
      /explorer-\w+ \(explorer\) - failed\nTask: task 1\nFailed: rate limited/,
    );
  });

  it("treats an empty final answer and an aborted run as failures", async () => {
    const { run, runtime, host, registry } = setup();

    await run(tasks(2));
    host.settle();

    runtime.children[0].finish("   ");
    runtime.children[1].finish("partial", { aborted: true });

    const states = registry.list().map((record) => [record.state, record.error]);

    expect(states).toEqual([
      ["failed", "agent finished with an empty result"],
      ["failed", "aborted"],
    ]);
    expect(wakeTexts(host)).toHaveLength(1);
  });

  it("passes small results inline and large ones as a file path", async () => {
    const { run, runtime, host, registry } = setup({ inlineResultChars: 50 });
    const large = "x".repeat(500);

    await run(tasks(2));
    host.settle();

    runtime.children[0].finish("small");
    runtime.children[1].finish(large);

    const [small, big] = registry.list();

    expect(wakeTexts(host)[0]).toContain("\n\nsmall");
    expect(wakeTexts(host)[0]).not.toContain(large);
    expect(wakeTexts(host)[0]).toContain(`Result file: ${big.resultPath} (500 chars)`);
    expect(readFileSync(big.resultPath ?? "", "utf8")).toBe(`${large}\n`);
    expect(existsSync(small.resultPath ?? "")).toBe(true);
  });

  it("joins a busy turn as a hidden follow-up with no visible line", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(1));

    runtime.children[0].finish("done while busy");

    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("done while busy");
    expect(host.hidden[0].delivery).toBe("followUp");
    expect(host.sent).toEqual([]);

    host.settle();

    expect(host.hidden).toHaveLength(1);
  });

  it("names a single finished agent in the singular", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(1));
    host.settle();
    runtime.children[0].finish("one");

    expect(host.hidden.map((entry) => entry.visible)).toEqual(["↳ 1 agent finished"]);
  });

  it("sends each batch that settles during a busy turn as its own hidden follow-up", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(1));
    await run(tasks(1));

    runtime.children[0].finish("batch one");
    runtime.children[1].finish("batch two");

    expect(wakeTexts(host)).toHaveLength(2);
    expect(wakeTexts(host)[0]).toContain("batch one");
    expect(wakeTexts(host)[1]).toContain("batch two");
    expect(host.hidden.map((entry) => entry.delivery)).toEqual(["followUp", "followUp"]);
    expect(
      host.hidden.map((entry) => (entry.message.details as { batches: string[] }).batches.length),
    ).toEqual([1, 1]);
  });

  it("caps concurrency with the semaphore and starts queued agents as slots free up", async () => {
    const { run, runtime, host, registry } = setup({ maxConcurrent: 2 });

    await run(tasks(4));

    expect(runtime.children).toHaveLength(2);
    expect(registry.list().map((record) => record.state)).toEqual(["running", "running", "queued", "queued"]);

    host.settle();
    runtime.children[0].finish("a");
    await flush();

    expect(runtime.children).toHaveLength(3);

    runtime.children[1].finish("b");
    runtime.children[2].finish("c");
    await flush();
    runtime.children[3].finish("d");

    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("4 done");
  });

  it("returns results directly and sends no wake when wait is true", async () => {
    const { host, runtime, services } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");
    const pending = runAgent.execute({ agents: tasks(1), wait: true }, { update: () => {} });

    await flush();
    runtime.children[0].finish("waited result");

    const result = await pending;

    expect(result.text).toContain("waited result");
    expect(wakeTexts(host)).toEqual([]);
    expect(services.require("registry").list()[0].state).toBe("done");
  });

  it("rejects unknown agents before starting anything", async () => {
    const { host, runtime } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    await expect(
      runAgent.execute({ agents: [{ agent: "nope", task: "x" }] }, { update: () => {} }),
    ).rejects.toThrow(/unknown agent\(s\): nope. Available: explorer, general, implementer, reviewer/);
    expect(runtime.children).toEqual([]);
  });

  it("marks a spawn failure as failed and still wakes", async () => {
    const { run, runtime, host, registry } = setup();

    runtime.failNextSpawn = "no auth";
    await run(tasks(1));
    host.settle();

    expect(registry.list()[0]).toMatchObject({ state: "failed", error: "spawn failed: no auth" });
    expect(wakeTexts(host)).toHaveLength(1);
  });

  it("gives each agent its own directory under the parent session, a manifest and the composed task", async () => {
    const { run, runtime, registry, host } = setup();

    await run([{ agent: "explorer", task: "find auth", files: ["src/a.ts"] }]);

    const record = registry.list()[0];
    const child = runtime.children[0];

    expect(record.dir).toBe(join(String(host.info.file).replace(/\.jsonl$/, ""), "agents", record.id));
    expect(child.spec.sessionDir).toBe(record.dir);
    expect(child.spec.parentSessionFile).toBe(host.info.file);
    expect(child.spec.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(child.spec.promptAppend[1]).toContain("# Agent: explorer");
    expect(child.task).toBe(`Task from main (agent id ${record.id}):\nfind auth\n\nInput files:\n- src/a.ts`);
    expect(JSON.parse(readFileSync(join(record.dir, "manifest.json"), "utf8"))).toMatchObject({
      id: record.id,
      state: "running",
      depth: 2,
      callerId: "main",
    });
  });

  it("passes the agent's named tools at spawn", async () => {
    const harness = setup();
    const dir = join(harness.host.info.agentDir, "agents");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tracker.md"),
      `---\nname: tracker\ndescription: Files issues.\nlimit: 50000\ntools: read, ls\nskills: all\nsubagents: []\n---\n`,
    );
    harness.host.start();

    await harness.run([{ agent: "tracker", task: "file it" }]);

    expect(harness.runtime.children[0].spec.tools).toEqual(["read", "ls"]);
  });

  it("passes no allowlist for all and an empty one for [] at spawn", async () => {
    const harness = setup();
    const dir = join(harness.host.info.agentDir, "agents");
    const header = "description: d\nlimit: 50000\nsubagents: []\n";

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "open.md"), `---\nname: open\n${header}tools: all\nskills: all\n---\n`);
    writeFileSync(join(dir, "closed.md"), `---\nname: closed\n${header}tools: []\nskills: []\n---\n`);
    harness.host.start();

    await harness.run([
      { agent: "open", task: "a" },
      { agent: "closed", task: "b" },
    ]);

    const [open, closed] = harness.runtime.children.map((child) => child.spec);

    expect(open.tools).toBeUndefined();
    expect(open.skills).toBeUndefined();
    expect(closed).toMatchObject({ tools: [], skills: [] });
  });

  it("passes named skills, all as no list and [] as none at spawn", async () => {
    const harness = setup();
    const dir = join(harness.host.info.agentDir, "agents");
    const header = "description: d\nlimit: 50000\ntools: all\nsubagents: []\n";

    mkdirSync(dir, { recursive: true });

    [
      ["named", "[docs, git]"],
      ["every", "all"],
      ["none", "[]"],
    ].forEach(([name, skills]) => {
      writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n${header}skills: ${skills}\n---\n`);
    });

    harness.host.start();

    await harness.run([
      { agent: "named", task: "a" },
      { agent: "every", task: "b" },
      { agent: "none", task: "c" },
    ]);

    expect(harness.runtime.children.map((child) => child.spec.skills)).toEqual([
      ["docs", "git"],
      undefined,
      [],
    ]);
  });

  it("records the last tool name as activity on tool_start", async () => {
    const { run, runtime, registry } = setup();

    await run(tasks(1));
    runtime.children[0].emit({ type: "tool_start", toolName: "grep" });

    const record = registry.list()[0];

    expect(record.activity).toEqual({ kind: "tool", text: "grep", at: expect.any(Number) });
    expect(record.toolCalls).toBe(1);
  });

  it("records the first line of an assistant message as text activity", async () => {
    const { run, runtime, registry } = setup();

    await run(tasks(1));

    const emit = (text: string) =>
      runtime.children[0].emit({ type: "assistant_message", text, stopReason: "toolUse", toolCalls: 1 });

    emit("Looking at auth.\nMore");

    expect(registry.list()[0].activity).toEqual({
      kind: "text",
      text: "Looking at auth.",
      at: expect.any(Number),
    });

    emit("   ");

    expect(registry.list()[0].activity?.text).toBe("Looking at auth.");
  });

  it("emits agent:changed for activity", async () => {
    const { run, runtime, bus } = setup();

    await run(tasks(1));

    const seen: (string | undefined)[] = [];

    bus.on("agent:changed", (record) => {
      seen.push(record.activity?.text);
    });
    runtime.children[0].emit({ type: "tool_start", toolName: "bash" });

    expect(seen).toEqual(["bash"]);
  });

  it("spawns children without a dialog forwarder", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(1));

    expect(runtime.children[0].spec).not.toHaveProperty("prompts");
    expect(host.confirmations).toEqual([]);
  });

  it("exposes run_agent, message_agent and agent_status through the tools service", () => {
    const withStatus = createHarness([
      agentRegistryPlugin,
      agentDefinitionsPlugin,
      runAgentPlugin,
      agentStatusPlugin,
    ]);
    const without = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);
    const tools = withStatus.services.require("tools");
    const listed = tools.list();

    expect(listed.map((spec) => spec.name)).toEqual(["run_agent", "message_agent", "agent_status"]);
    expect(
      without.services
        .require("tools")
        .list()
        .map((spec) => spec.name),
    ).toEqual(["run_agent", "message_agent"]);

    listed.pop();

    expect(tools.list()).toHaveLength(3);
  });

  it("marks running agents failed on shutdown and never wakes for them", async () => {
    const { run, runtime, host, registry } = setup();

    await run(tasks(2));
    host.settle();
    await host.shutdown("reload");

    expect(registry.list().map((record) => record.error)).toEqual([
      "interrupted: session reload",
      "interrupted: session reload",
    ]);
    expect(runtime.children.every((child) => child.aborted && child.disposed)).toBe(true);
    expect(wakeTexts(host)).toEqual([]);
  });
});

describe("allowed subagents", () => {
  const LEAD_AGENT = [
    "---",
    "name: lead",
    "description: Test agent that may only spawn the explorer.",
    "limit: 50000",
    "tools: all",
    "skills: all",
    "subagents: [explorer]",
    "---",
    "Lead the work.",
  ].join("\n");

  const setupLead = async () => {
    const harness = setup({ maxDepth: 3 });
    const userAgentsDir = join(harness.host.info.agentDir, "agents");

    mkdirSync(userAgentsDir, { recursive: true });
    writeFileSync(join(userAgentsDir, "lead.md"), LEAD_AGENT);
    harness.host.start();

    await harness.run([{ agent: "lead", task: "coordinate" }]);

    const lead = harness.registry.list()[0];
    const runner = harness.services.require("runner") as Runner;

    return { ...harness, lead, runner };
  };

  it("lets the main session spawn every loaded agent", async () => {
    const { run, registry } = setup();

    await run([
      { agent: "explorer", task: "a" },
      { agent: "implementer", task: "b" },
      { agent: "reviewer", task: "c" },
    ]);

    expect(registry.list()).toHaveLength(3);
  });

  it("rejects an agent outside the caller's subagents list before starting anything", async () => {
    const { lead, runner, runtime } = await setupLead();
    const spawn = (agent: string) =>
      runner.startBatch([{ agent, task: "x" }], { callerId: lead.id, wait: false });

    expect(() => spawn("reviewer")).toThrow(
      "agent(s) not allowed for this caller: reviewer. Allowed: explorer",
    );
    expect(runtime.children).toHaveLength(1);

    const started = spawn("explorer");

    await flush();

    expect(started.records.map((record) => record.callerId)).toEqual([lead.id]);
    expect(runtime.children).toHaveLength(2);
  });

  it("rejects every agent for a caller with an empty subagents list", async () => {
    const { run, registry, services } = setup({ maxDepth: 3 });

    await run([{ agent: "explorer", task: "look" }]);

    const explorer = registry.list()[0];
    const runner = services.require("runner") as Runner;

    expect(() =>
      runner.startBatch([{ agent: "reviewer", task: "x" }], {
        callerId: explorer.id,
        wait: false,
      }),
    ).toThrow("agent(s) not allowed for this caller: reviewer. Allowed: none");
  });

  it("lets a caller with subagents: all start every other agent but not itself", async () => {
    const harness = setup({ maxDepth: 3 });
    const dir = join(harness.host.info.agentDir, "agents");

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "lead.md"),
      LEAD_AGENT.replace("subagents: [explorer]", "subagents: all").replace(
        "description: Test agent that may only spawn the explorer.",
        "description: Lead.",
      ),
    );
    harness.host.start();

    await harness.run([{ agent: "lead", task: "coordinate" }]);

    const lead = harness.registry.list()[0];
    const runner = harness.services.require("runner") as Runner;
    const spawn = (agent: string) =>
      runner.startBatch([{ agent, task: "x" }], { callerId: lead.id, wait: false });

    expect(() => spawn("lead")).toThrow(
      "agent(s) not allowed for this caller: lead. Allowed: explorer, general, implementer, reviewer",
    );

    spawn("implementer");
    await flush();

    expect(harness.runtime.children).toHaveLength(2);

    const description = (harness.runtime.children[0].spec.customTools ?? []).find(
      (tool) => tool.name === "run_agent",
    )?.description;

    expect(description).toContain("- explorer:");
    expect(description).toContain("- general:");
    expect(description).not.toContain("- lead:");
  });
});

describe("semaphore", () => {
  it("never grants more than the limit", async () => {
    const semaphore = createSemaphore(() => 2);
    const releases = await Promise.all([semaphore.acquire(), semaphore.acquire()]);
    let third = false;

    void semaphore.acquire().then(() => {
      third = true;
    });

    await flush();

    expect(third).toBe(false);

    releases[0]();
    releases[0]();
    await flush();

    expect(third).toBe(true);

    let fourth = false;

    void semaphore.acquire().then(() => {
      fourth = true;
    });

    await flush();

    expect(fourth).toBe(false);
  });
});

describe("outbox", () => {
  const item = (text: string) => ({ batchId: `b-${text}`, text, agents: 1 });

  it("delivers at once when idle and holds while busy", () => {
    const delivered: OutboxItem[][] = [];
    let busy = false;
    let idleHandler = () => {};

    const outbox = createOutbox({
      isBusy: () => busy,
      deliver: (items) => delivered.push(items),
      onIdle: (handler) => {
        idleHandler = handler;
      },
    });

    outbox.post(item("one"));

    busy = true;
    outbox.post(item("two"));
    outbox.post(item("three"));

    expect(delivered).toEqual([[item("one")]]);

    idleHandler();

    expect(delivered).toEqual([[item("one")], [item("two"), item("three")]]);
    expect(joinTexts(delivered[1])).toBe("two\n\n---\n\nthree");
  });
});

describe("main session prompt", () => {
  const prompt = (file: string) => readFileSync(join(PACKAGE_ROOT, "prompts", file), "utf8").trim();

  it("adds the agent_status section only when that plugin is on", () => {
    const withStatus = createHarness([
      agentRegistryPlugin,
      agentDefinitionsPlugin,
      runAgentPlugin,
      agentStatusPlugin,
    ]);
    const without = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);

    expect(withStatus.host.mainPrompt).toBe(
      `${prompt("main-session.md")}\n\n${prompt("main-session-agent-status.md")}`,
    );
    expect(without.host.mainPrompt).toBe(prompt("main-session.md"));
    expect(without.host.mainPrompt).not.toContain("agent_status");
  });
});
