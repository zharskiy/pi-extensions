import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { flushMicrotasks, hiddenMessageTexts } from "../../../../../test-framework/index.ts";
import { createOutbox, joinTexts } from "../../../core/run-agent/outbox.ts";
import type { Runner } from "../../../core/run-agent/runner.ts";
import { createSemaphore } from "../../../core/run-agent/semaphore.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../core/run-agent/tools.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentStatusPlugin } from "../../../src/plugins/agent-status/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { createHarness, PACKAGE_ROOT } from "../../support/subagents-harness.ts";

const setup = (overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], { overrides });
  const runAgent = harness.host.tool<RunAgentParams, RunAgentDetails>("run_agent");
  const registry = harness.services.require("registry");

  const run = async (agents: RunAgentParams["agents"], wait = false) => {
    harness.host.idle = false;

    const result = await runAgent.execute({ agents, wait }, { update: () => {} });

    await flushMicrotasks();

    return result;
  };

  return { ...harness, run, registry };
};

const tasks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ agent: "scout", task: `task ${index}` }));

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

    expect(hiddenMessageTexts(host)).toEqual([]);

    runtime.children[2].finish("third result");
    await flushMicrotasks();

    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("finished: 3 done");
    expect(hiddenMessageTexts(host)[0]).toContain("first result");
    expect(hiddenMessageTexts(host)[0]).toContain("third result");
    expect(host.hidden[0]).toMatchObject({
      message: { customType: "pi-subagents:wake" },
      delivery: "run",
    });
    expect(registry.list().every((record) => record.state === "done")).toBe(true);

    await flushMicrotasks();

    expect(runtime.children.every((child) => child.disposed)).toBe(true);
  });

  it("still wakes once when one agent fails, with the failure marked", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(3));
    host.settle();

    runtime.children[0].finish("ok one");
    runtime.children[1].finish("", { stopReason: "error", error: "rate limited" });
    runtime.children[2].finish("ok three");
    await flushMicrotasks();

    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("2 done, 1 failed");
    expect(hiddenMessageTexts(host)[0]).toMatch(
      /scout-\w+ \(scout\) - failed\nTask: task 1\nFailed · rate limited · /,
    );
  });

  it("treats an empty final answer and an aborted run as failures", async () => {
    const { run, runtime, host, registry } = setup();

    await run(tasks(2));
    host.settle();

    runtime.children[0].finish("   ");
    runtime.children[1].finish("partial", { aborted: true });
    await flushMicrotasks();

    const states = registry.list().map((record) => [record.state, record.error]);

    expect(states).toEqual([
      ["failed", "agent finished with an empty result"],
      ["failed", "aborted"],
    ]);
    expect(hiddenMessageTexts(host)).toHaveLength(1);
  });

  it("passes small results inline and large ones as their head up to a newline and a file marker", async () => {
    const { run, runtime, host, registry } = setup({ inlineResultChars: 50 });
    const large = `Status: done\n${"a".repeat(30)}\n${"x".repeat(500)}`;

    await run(tasks(2));
    host.settle();

    runtime.children[0].finish("Status: done\nsmall");
    runtime.children[1].finish(large);
    await flushMicrotasks();

    const [small, big] = registry.list();
    const wake = hiddenMessageTexts(host)[0];

    expect(wake).toContain("\n\nStatus: done\nsmall");
    expect(wake).not.toContain("x".repeat(500));
    expect(wake).not.toContain("Preview:");
    expect(
      wake.endsWith(`\n\nStatus: done\n${"a".repeat(30)}\nResult file: ${big.resultPath} (501 more chars)`),
    ).toBe(true);
    expect(readFileSync(big.resultPath ?? "", "utf8")).toBe(`${large}\n`);
    expect(existsSync(small.resultPath ?? "")).toBe(true);
  });

  it("cuts a result without a newline at the limit and gives only the marker for a limit of 0", async () => {
    const cut = setup({ inlineResultChars: 10 });

    await cut.run(tasks(1));
    cut.host.settle();
    cut.runtime.children[0].finish(`Status: ${"y".repeat(30)}`);
    await flushMicrotasks();

    expect(hiddenMessageTexts(cut.host)[0]).toContain(
      `\n\nStatus: yy\nResult file: ${cut.registry.list()[0].resultPath} (28 more chars)`,
    );

    const none = setup({ inlineResultChars: 0 });

    await none.run(tasks(1));
    none.host.settle();
    none.runtime.children[0].finish("Status: done");
    await flushMicrotasks();

    expect(hiddenMessageTexts(none.host)[0]).toMatch(/\n\nResult file: \S+ \(12 more chars\)$/);
  });

  it("takes the last text of the final run that carries a Status line, without spending a turn", async () => {
    const { run, runtime, host, registry } = setup();

    await run(tasks(1));
    host.settle();

    const child = runtime.children[0];

    child.texts = ["thinking aloud", "**Status:** done\nthe report", "Done, see above."];
    child.finish("Done, see above.");
    await flushMicrotasks();

    expect(registry.list()[0].resultText).toBe("**Status:** done\nthe report");
    expect(hiddenMessageTexts(host)[0]).not.toContain("(shape: no Status line)");
    expect(child.wakes).toEqual([]);
  });

  it("marks a result without a Status line with a shape note", async () => {
    const { run, runtime, host, registry } = setup();

    await run(tasks(1));
    host.settle();
    runtime.children[0].finish("just prose");
    await flushMicrotasks();

    expect(registry.list()[0].state).toBe("done");
    expect(hiddenMessageTexts(host)[0]).toContain("(shape: no Status line)\n\njust prose");
  });

  it("shows a failed agent's last text as unverified partial output and stores its result file", async () => {
    const { run, runtime, host, registry } = setup();

    await run(tasks(1));
    host.settle();
    runtime.children[0].finish("half a report", { stopReason: "error", error: "rate limited" });
    await flushMicrotasks();

    const [record] = registry.list();

    expect(record.state).toBe("failed");
    expect(record.error).toBe("rate limited");
    expect(readFileSync(record.resultPath ?? "", "utf8")).toBe("half a report\n");
    expect(hiddenMessageTexts(host)[0]).toMatch(
      /Failed · rate limited · [^\n]*\n\(unverified partial output: rate limited\)\n\nhalf a report$/,
    );
  });

  it("joins a busy turn as a hidden follow-up", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(1));

    runtime.children[0].finish("done while busy");
    await flushMicrotasks();

    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("done while busy");
    expect(host.hidden[0].delivery).toBe("followUp");

    host.settle();

    expect(host.hidden).toHaveLength(1);
  });

  it("sends each batch that settles during a busy turn as its own hidden follow-up", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(1));
    await run(tasks(1));

    runtime.children[0].finish("batch one");
    await flushMicrotasks();
    runtime.children[1].finish("batch two");
    await flushMicrotasks();

    expect(hiddenMessageTexts(host)).toHaveLength(2);
    expect(hiddenMessageTexts(host)[0]).toContain("batch one");
    expect(hiddenMessageTexts(host)[1]).toContain("batch two");
    expect(host.hidden.map((entry) => entry.delivery)).toEqual(["followUp", "followUp"]);
    expect(hiddenMessageTexts(host).map((text) => text.split("\n\n---\n\n").length)).toEqual([1, 1]);
  });

  it("merges batches that settle in the same tick while idle into one wake", async () => {
    const { run, runtime, host } = setup();

    await run(tasks(1));
    await run(tasks(1));
    host.settle();

    runtime.children[0].finish("batch one");
    runtime.children[1].finish("batch two");

    expect(host.hidden).toEqual([]);

    await flushMicrotasks();

    expect(host.hidden).toHaveLength(1);
    expect(host.hidden[0].delivery).toBe("run");
    expect(host.hidden[0].message.text).toContain("batch one");
    expect(host.hidden[0].message.text).toContain("batch two");
    expect(host.hidden[0].message.text.split("\n\n---\n\n")).toHaveLength(2);
    expect(host.hidden[0].message.details).toBeUndefined();
  });

  it("caps concurrency with the semaphore and starts queued agents as slots free up", async () => {
    const { run, runtime, host, registry } = setup({ maxConcurrent: 2 });

    await run(tasks(4));

    expect(runtime.children).toHaveLength(2);
    expect(registry.list().map((record) => record.state)).toEqual(["running", "running", "queued", "queued"]);

    host.settle();
    runtime.children[0].finish("a");
    await flushMicrotasks();

    expect(runtime.children).toHaveLength(3);

    runtime.children[1].finish("b");
    runtime.children[2].finish("c");
    await flushMicrotasks();
    runtime.children[3].finish("d");
    await flushMicrotasks();

    expect(hiddenMessageTexts(host)).toHaveLength(1);
    expect(hiddenMessageTexts(host)[0]).toContain("4 done");
  });

  it("returns results directly and sends no wake when wait is true", async () => {
    const { host, runtime, services } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");
    const pending = runAgent.execute({ agents: tasks(1), wait: true }, { update: () => {} });

    await flushMicrotasks();
    runtime.children[0].finish("waited result");

    const result = await pending;

    expect(result.text).toContain("waited result");
    expect(hiddenMessageTexts(host)).toEqual([]);
    expect(services.require("registry").list()[0].state).toBe("done");
  });

  it("rejects unknown agents before starting anything", async () => {
    const { host, runtime } = setup();
    const runAgent = host.tool<RunAgentParams, RunAgentDetails>("run_agent");

    await expect(
      runAgent.execute({ agents: [{ agent: "nope", task: "x" }] }, { update: () => {} }),
    ).rejects.toThrow(
      /unknown agent\(s\): nope. Available: editor, fetch, general, image, implementer, planner, reviewer, scout, shell, verifier/,
    );
    expect(runtime.children).toEqual([]);
  });

  it("marks a spawn failure as failed and still wakes", async () => {
    const { run, runtime, host, registry } = setup();

    runtime.failNextSpawn = "no auth";
    await run(tasks(1));
    host.settle();

    expect(registry.list()[0]).toMatchObject({ state: "failed", error: "spawn failed: no auth" });
    expect(hiddenMessageTexts(host)).toHaveLength(1);
  });

  it("gives each agent its own directory under the parent session, a manifest and the composed task", async () => {
    const { run, runtime, registry, host } = setup();

    await run([{ agent: "scout", task: "find auth", files: ["src/a.ts"] }]);

    const record = registry.list()[0];
    const child = runtime.children[0];

    expect(record.dir).toBe(join(String(host.info.file).replace(/\.jsonl$/, ""), "agents", record.id));
    expect(child.spec.sessionDir).toBe(record.dir);
    expect(child.spec.parentSessionFile).toBe(host.info.file);
    expect(child.spec.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(child.spec.promptAppend[1]).toContain("# Agent: scout");
    expect(child.task).toBe(
      `Task from main (agent id ${record.id}):\nAgent folder: ${record.dir}\nfind auth\n\nInput files:\n- src/a.ts`,
    );
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

  it("passes no tool allowlist for all and empty lists for [] at spawn", async () => {
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
    expect(open.skills).toEqual([]);
    expect(closed).toMatchObject({ tools: [], skills: [] });
  });

  it("passes named skills, all as the main session's skills and [] as none at spawn", async () => {
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
    harness.runtime.skills = ["docs", "git", "lint"];
    harness.runtime.sessionSkills = ["docs", "lint"];

    await harness.run([
      { agent: "named", task: "a" },
      { agent: "every", task: "b" },
      { agent: "none", task: "c" },
    ]);

    expect(harness.runtime.children.map((child) => child.spec.skills)).toEqual([
      ["docs", "git"],
      ["docs", "lint"],
      [],
    ]);
  });

  it("declares skills as a string list on each item of the schema", () => {
    const { host } = setup();
    const parameters = host.tool<RunAgentParams, RunAgentDetails>("run_agent").parameters as {
      properties: {
        agents: { items: { properties: Record<string, unknown>; additionalProperties: boolean } };
      };
    };
    const item = parameters.properties.agents.items;

    expect(item.properties.skills).toEqual({
      type: "array",
      items: { type: "string" },
      description:
        "Skill names to add for this agent: skills you have whose descriptions fit the task, plus any the user named. None for chores. A skill you do not have starts nothing; the error lists yours.",
    });
    expect(item.additionalProperties).toBe(false);
  });

  it("records the last tool name as activity on tool_start", async () => {
    const { run, runtime, registry } = setup();

    await run(tasks(1));
    runtime.children[0].emit({ type: "tool_start", toolName: "grep" });

    const record = registry.list()[0];

    expect(record.activity).toBe("grep");
    expect(record.toolCalls).toBe(1);
  });

  it("records writing for an assistant message with text and keeps it through blank messages", async () => {
    const { run, runtime, registry } = setup();

    await run(tasks(1));

    const emit = (text: string) =>
      runtime.children[0].emit({ type: "assistant_message", text, stopReason: "toolUse", toolCalls: 1 });

    emit("Looking at auth.\nMore");

    expect(registry.list()[0].activity).toBe("writing");

    runtime.children[0].emit({ type: "tool_start", toolName: "grep" });
    emit("   ");

    expect(registry.list()[0].activity).toBe("grep");
  });

  it("emits agent:changed only when the activity changes", async () => {
    const { run, runtime, bus } = setup();

    await run(tasks(1));

    const seen: (string | undefined)[] = [];
    const write = () =>
      runtime.children[0].emit({
        type: "assistant_message",
        text: "More.",
        stopReason: "toolUse",
        toolCalls: 1,
      });

    bus.on("agent:changed", (record) => {
      seen.push(record.activity);
    });
    runtime.children[0].emit({ type: "tool_start", toolName: "bash" });
    write();
    write();

    expect(seen).toEqual(["bash", "writing"]);
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
    expect(hiddenMessageTexts(host)).toEqual([]);
  });
});

describe("allowed subagents", () => {
  const LEAD_AGENT = [
    "---",
    "name: lead",
    "description: Test agent that may only spawn the scout.",
    "limit: 50000",
    "tools: all",
    "skills: all",
    "subagents: [scout]",
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
      { agent: "scout", task: "a" },
      { agent: "implementer", task: "b" },
      { agent: "reviewer", task: "c" },
    ]);

    expect(registry.list()).toHaveLength(3);
  });

  it("rejects an agent outside the caller's subagents list before starting anything", async () => {
    const { lead, runner, runtime } = await setupLead();
    const spawn = (agent: string) =>
      runner.startBatch([{ agent, task: "x" }], { callerId: lead.id, wait: false });

    expect(() => spawn("reviewer")).toThrow("agent(s) not allowed for this caller: reviewer. Allowed: scout");
    expect(runtime.children).toHaveLength(1);

    const started = spawn("scout");

    await flushMicrotasks();

    expect(started.records.map((record) => record.callerId)).toEqual([lead.id]);
    expect(runtime.children).toHaveLength(2);
  });

  it("rejects every agent for a caller with an empty subagents list", async () => {
    const { run, registry, services } = setup({ maxDepth: 3 });

    await run([{ agent: "scout", task: "look" }]);

    const scout = registry.list()[0];
    const runner = services.require("runner") as Runner;

    expect(() =>
      runner.startBatch([{ agent: "reviewer", task: "x" }], {
        callerId: scout.id,
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
      LEAD_AGENT.replace("subagents: [scout]", "subagents: all").replace(
        "description: Test agent that may only spawn the scout.",
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
      "agent(s) not allowed for this caller: lead. Allowed: editor, fetch, general, image, implementer, planner, reviewer, scout, shell, verifier",
    );

    spawn("implementer");
    await flushMicrotasks();

    expect(harness.runtime.children).toHaveLength(2);

    const description = (harness.runtime.children[0].spec.customTools ?? []).find(
      (tool) => tool.name === "run_agent",
    )?.description;

    expect(description).toContain("- scout:");
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

    await flushMicrotasks();

    expect(third).toBe(false);

    releases[0]();
    releases[0]();
    await flushMicrotasks();

    expect(third).toBe(true);

    let fourth = false;

    void semaphore.acquire().then(() => {
      fourth = true;
    });

    await flushMicrotasks();

    expect(fourth).toBe(false);
  });
});

describe("outbox", () => {
  it("delivers at once when idle and holds while busy", () => {
    const delivered: string[][] = [];
    let busy = false;
    let idleHandler = () => {};

    const outbox = createOutbox({
      isBusy: () => busy,
      deliver: (items) => delivered.push(items),
      onIdle: (handler) => {
        idleHandler = handler;
      },
    });

    outbox.post("one");

    busy = true;
    outbox.post("two");
    outbox.post("three");

    expect(delivered).toEqual([["one"]]);

    idleHandler();

    expect(delivered).toEqual([["one"], ["two", "three"]]);
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
