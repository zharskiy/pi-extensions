import { describe, expect, it } from "vitest";
import type { ChildPrompts, HostUi } from "../../../../../core/adapter/contract.ts";
import { createBus } from "../../../../../core/manager/bus.ts";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import type { BusEvents } from "../../../src/model/events.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { createRegistry } from "../../../src/plugins/agent-registry/registry.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import { childPromptsFor, createPromptQueue, promptTitle } from "../../../src/plugins/run-agent/prompts.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });

  return { promise, resolve };
};

const createTestRegistry = () => {
  const bus = createBus<BusEvents>();
  let count = 0;

  const newId = (agent: string) => {
    count += 1;

    return `${agent}-${String(count).padStart(4, "0")}`;
  };

  const registry = createRegistry({ bus, writeManifest: () => {}, newId });

  const spawn = (agent: string) =>
    registry.create({
      agent,
      task: "look",
      description: "look",
      callerId: "main",
      depth: 1,
      batchId: "b1",
      dir: "/tmp/prompts-test",
      contextLimit: 1000,
    });

  return { bus, registry, spawn };
};

const setup = () => {
  const { bus, registry, spawn } = createTestRegistry();
  const record = spawn("explorer");

  const calls: { kind: string; args: unknown[] }[] = [];
  const answers = {
    confirm: deferred<boolean>(),
    select: deferred<string | undefined>(),
    input: deferred<string | undefined>(),
  };

  const ui = {
    confirm: (title: string, message: string) => {
      calls.push({ kind: "confirm", args: [title, message] });
      return answers.confirm.promise;
    },
    select: (title: string, options: string[]) => {
      calls.push({ kind: "select", args: [title, options] });
      return answers.select.promise;
    },
    input: (title: string, placeholder?: string) => {
      calls.push({ kind: "input", args: [title, placeholder] });
      return answers.input.promise;
    },
    notify: (message: string, level?: string) => {
      calls.push({ kind: "notify", args: [message, level] });
    },
  } as unknown as HostUi;

  const changes: AgentRecord[] = [];

  bus.on("agent:changed", (changed) => {
    changes.push({ ...changed });
  });

  const prompts: ChildPrompts = childPromptsFor(
    { ui, registry, queue: createPromptQueue(), now: () => 4242 },
    record,
  );

  return { registry, record, calls, answers, prompts, changes };
};

describe("childPromptsFor", () => {
  it("forwards a confirm with the agent-naming title and flags attention while pending", async () => {
    const { prompts, calls, answers, registry, record } = setup();
    const pending = prompts.confirm("Run bash?", "rm -rf build");

    expect(calls).toEqual([
      { kind: "confirm", args: ["explorer-0001 (explorer) asks: Run bash?", "rm -rf build"] },
    ]);
    expect(registry.get(record.id)?.attention).toEqual({ kind: "confirm", title: "Run bash?", since: 4242 });

    answers.confirm.resolve(true);

    expect(await pending).toBe(true);
    expect(registry.get(record.id)?.attention).toBeUndefined();
  });

  it("builds the title from the record", () => {
    expect(promptTitle({ id: "a-1", agent: "worker" }, "Ok?")).toBe("a-1 (worker) asks: Ok?");
  });

  it("lets Esc deny one call without stopping the agent", async () => {
    const { prompts, answers, registry, record } = setup();
    const stateBefore = record.state;
    const pending = prompts.confirm("Run bash?", "ls");

    answers.confirm.resolve(false);

    expect(await pending).toBe(false);
    expect(registry.get(record.id)?.state).toBe(stateBefore);
    expect(registry.get(record.id)?.attention).toBeUndefined();
  });

  it("forwards select with its options", async () => {
    const { prompts, calls, answers, registry, record } = setup();
    const pending = prompts.select("Pick", ["a", "b"]);

    expect(calls[0]).toEqual({ kind: "select", args: ["explorer-0001 (explorer) asks: Pick", ["a", "b"]] });
    expect(registry.get(record.id)?.attention?.kind).toBe("select");

    answers.select.resolve("b");

    expect(await pending).toBe("b");
  });

  it("forwards input with its placeholder", async () => {
    const { prompts, calls, answers, registry, record } = setup();
    const pending = prompts.input("Name?", "type here");

    expect(calls[0]).toEqual({ kind: "input", args: ["explorer-0001 (explorer) asks: Name?", "type here"] });
    expect(registry.get(record.id)?.attention).toEqual({ kind: "input", title: "Name?", since: 4242 });

    answers.input.resolve("bob");

    expect(await pending).toBe("bob");
    expect(registry.get(record.id)?.attention).toBeUndefined();
  });

  it("denies without a dialog once the record is closed", async () => {
    const { prompts, calls, registry, record } = setup();

    registry.close(record.id, { state: "done" });

    expect(await prompts.confirm("t", "m")).toBe(false);
    expect(await prompts.select("t", ["a"])).toBeUndefined();
    expect(await prompts.input("t")).toBeUndefined();
    expect(calls).toEqual([]);
    expect(registry.get(record.id)?.attention).toBeUndefined();
  });

  it("does not touch a record that closes while the dialog is pending", async () => {
    const { prompts, answers, registry, record, changes } = setup();
    const pending = prompts.confirm("t", "m");

    registry.close(record.id, { state: "done" });

    const changesAfterClose = changes.length;

    answers.confirm.resolve(true);

    expect(await pending).toBe(true);
    expect(changes).toHaveLength(changesAfterClose);
    expect(registry.get(record.id)?.state).toBe("done");
  });

  it("prefixes notifications with the agent id and name", () => {
    const { prompts, calls } = setup();

    prompts.notify("heads up", "warning");

    expect(calls).toEqual([{ kind: "notify", args: ["explorer-0001 (explorer): heads up", "warning"] }]);
  });

  it("emits agent:changed when attention is set and cleared", async () => {
    const { prompts, answers, changes } = setup();
    const before = changes.length;
    const pending = prompts.confirm("t", "m");

    expect(changes).toHaveLength(before + 1);
    expect(changes[before].attention?.kind).toBe("confirm");

    answers.confirm.resolve(true);
    await pending;

    expect(changes).toHaveLength(before + 2);
    expect(changes[before + 1].attention).toBeUndefined();
  });
});

const queuedSetup = () => {
  const { registry, spawn } = createTestRegistry();
  const shown: { title: string; answer: Deferred<boolean> }[] = [];

  const ui = {
    confirm: (title: string) => {
      const answer = deferred<boolean>();

      shown.push({ title, answer });

      return answer.promise;
    },
  } as unknown as HostUi;

  const queue = createPromptQueue();
  const promptsOf = (record: AgentRecord) => childPromptsFor({ ui, registry, queue, now: () => 7 }, record);

  return { registry, spawn, shown, promptsOf };
};

describe("prompt queue", () => {
  it("shows one dialog at a time across agents and answers both", async () => {
    const { registry, spawn, shown, promptsOf } = queuedSetup();
    const first = spawn("explorer");
    const second = spawn("worker");

    const firstAnswer = promptsOf(first).confirm("One?", "m");
    const secondAnswer = promptsOf(second).confirm("Two?", "m");

    await flush();

    expect(shown.map((entry) => entry.title)).toEqual(["explorer-0001 (explorer) asks: One?"]);
    expect(registry.get(first.id)?.attention).toEqual({ kind: "confirm", title: "One?", since: 7 });
    expect(registry.get(second.id)?.attention).toEqual({ kind: "confirm", title: "Two?", since: 7 });

    shown[0].answer.resolve(true);

    expect(await firstAnswer).toBe(true);

    await flush();

    expect(shown.map((entry) => entry.title)).toEqual([
      "explorer-0001 (explorer) asks: One?",
      "worker-0002 (worker) asks: Two?",
    ]);
    expect(registry.get(first.id)?.attention).toBeUndefined();
    expect(registry.get(second.id)?.attention?.title).toBe("Two?");

    shown[1].answer.resolve(false);

    expect(await secondAnswer).toBe(false);
    expect(registry.get(second.id)?.attention).toBeUndefined();
  });

  it("keeps attention until the last overlapping prompt of a record finishes", async () => {
    const { registry, spawn, shown, promptsOf } = queuedSetup();
    const record = spawn("explorer");
    const prompts = promptsOf(record);

    const firstAnswer = prompts.confirm("One?", "m");
    const secondAnswer = prompts.confirm("Two?", "m");

    await flush();

    expect(shown).toHaveLength(1);
    expect(registry.get(record.id)?.attention?.title).toBe("One?");

    shown[0].answer.resolve(true);

    expect(await firstAnswer).toBe(true);

    await flush();

    expect(shown).toHaveLength(2);
    expect(registry.get(record.id)?.attention?.title).toBe("Two?");

    shown[1].answer.resolve(true);

    expect(await secondAnswer).toBe(true);
    expect(registry.get(record.id)?.attention).toBeUndefined();
  });

  it("denies a queued prompt without a dialog when its record closes while waiting", async () => {
    const { registry, spawn, shown, promptsOf } = queuedSetup();
    const first = spawn("explorer");
    const second = spawn("worker");

    const firstAnswer = promptsOf(first).confirm("One?", "m");
    const secondAnswer = promptsOf(second).confirm("Two?", "m");

    registry.close(second.id, { state: "stopped" });
    shown[0].answer.resolve(true);

    expect(await firstAnswer).toBe(true);
    expect(await secondAnswer).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it("keeps serving dialogs after one rejects", async () => {
    const queue = createPromptQueue();

    await expect(queue.enqueue(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await queue.enqueue(() => Promise.resolve(3))).toBe(3);
  });
});

describe("child prompts through run_agent", () => {
  it("routes a child dialog to the main session and tracks attention", async () => {
    const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin]);
    const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");
    const registry = harness.services.require("registry");

    await runAgent.execute({ agents: [{ agent: "explorer", task: "look" }] }, { update: () => {} });
    await flush();

    const [record] = registry.list();
    const answer = deferred<boolean>();

    harness.host.confirmAnswer = () => true;
    harness.host.ui.confirm = async (title, message) => {
      harness.host.confirmations.push({ title, message });
      return answer.promise;
    };

    const pending = harness.runtime.child(record.id).spec.prompts?.confirm("Run bash?", "rm -rf build");

    expect(harness.host.confirmations).toEqual([
      { title: `${record.id} (explorer) asks: Run bash?`, message: "rm -rf build" },
    ]);
    expect(registry.get(record.id)?.attention?.kind).toBe("confirm");

    answer.resolve(true);

    expect(await pending).toBe(true);
    expect(registry.get(record.id)?.attention).toBeUndefined();
  });
});
