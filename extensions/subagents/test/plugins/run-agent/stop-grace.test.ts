import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { MessageAgentParams, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness, wakeTexts } from "../../helpers/harness.ts";

const GRACE_MS = 60_000;

const setup = async (count = 1, overrides = {}) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], overrides);
  const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");
  const messageAgent = harness.host.tool<MessageAgentParams, { delivery?: string }>("message_agent");
  const registry = harness.services.require("registry");
  const runner = harness.services.require("runner");
  const agents = Array.from({ length: count }, (_, index) => ({ agent: "explorer", task: `task ${index}` }));

  await runAgent.execute({ agents }, { update: () => {} });
  await flush();

  harness.host.settle();

  const send = (id: string, message: string) => messageAgent.execute({ id, message }, { update: () => {} });
  const ids = registry.list().map((record) => record.id);

  return { ...harness, registry, runner, send, ids };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stop grace period", () => {
  it("answers a message after stop and wakes once with the answer when the grace period ends", async () => {
    const { registry, runner, runtime, host, send, ids } = await setup();
    const [id] = ids;
    const child = runtime.child(id);

    expect(await runner.stop(id)).toBe(true);
    expect(child.aborted).toBe(true);
    expect(registry.get(id)).toMatchObject({ state: "grace", graceEndsAt: Date.now() + GRACE_MS });
    expect(wakeTexts(host)).toEqual([]);

    vi.advanceTimersByTime(30_000);

    const result = await send(id, "what did you find so far?");

    expect(result.details?.delivery).toBe("followUp");
    expect(child.messages[0].delivery).toBe("followUp");
    expect(registry.get(id)?.graceEndsAt).toBeUndefined();

    vi.advanceTimersByTime(5 * GRACE_MS);

    expect(registry.get(id)?.state).toBe("grace");
    expect(wakeTexts(host)).toEqual([]);

    child.finish("the handler lives in src/auth.ts");

    expect(registry.get(id)?.graceEndsAt).toBe(Date.now() + GRACE_MS);

    vi.advanceTimersByTime(GRACE_MS - 1);

    expect(wakeTexts(host)).toEqual([]);

    vi.advanceTimersByTime(1);
    await flush();

    expect(registry.get(id)).toMatchObject({ state: "stopped", graceEndsAt: undefined });
    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("finished: 1 stopped");
    expect(wakeTexts(host)[0]).toContain("the handler lives in src/auth.ts");
    expect(child.disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes once with the last output when the grace period ends without a message", async () => {
    const { registry, runner, runtime, host, ids } = await setup();
    const [id] = ids;
    const child = runtime.child(id);

    child.text = "partial findings";
    await runner.stop(id);

    vi.advanceTimersByTime(GRACE_MS - 1);

    expect(registry.get(id)?.state).toBe("grace");
    expect(wakeTexts(host)).toEqual([]);

    vi.advanceTimersByTime(1);
    await flush();

    expect(registry.get(id)?.state).toBe("stopped");
    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("partial findings");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a batch open while one member is in grace and wakes once when both are closed", async () => {
    const { registry, runner, runtime, host, ids } = await setup(2);
    const [stopped, running] = ids;

    await runner.stop(stopped);
    runtime.child(running).finish("second result");

    expect(registry.get(running)?.state).toBe("done");
    expect(wakeTexts(host)).toEqual([]);

    vi.advanceTimersByTime(GRACE_MS);
    await flush();

    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("finished: 1 stopped, 1 done");
    expect(wakeTexts(host)[0]).toContain("second result");
  });

  it("closes at once and wakes on a second stop during grace", async () => {
    const { registry, runner, host, ids } = await setup();
    const [id] = ids;

    await runner.stop(id);
    await runner.stop(id);
    await flush();

    expect(registry.get(id)?.state).toBe("stopped");
    expect(wakeTexts(host)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(GRACE_MS);

    expect(wakeTexts(host)).toHaveLength(1);
  });

  it("closes as stopped and never wakes when the session shuts down during grace", async () => {
    const { registry, runner, runtime, host, ids } = await setup();
    const [id] = ids;

    await runner.stop(id);
    await host.shutdown("reload");

    expect(registry.get(id)?.state).toBe("stopped");
    expect(runtime.child(id).disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(GRACE_MS);

    expect(wakeTexts(host)).toEqual([]);
  });

  it("stops waiting for an abort the child never answers, then disposes it on stop and shutdown", async () => {
    const { registry, runner, runtime, host, ids } = await setup(2, { stopGraceSeconds: 0 });
    const [stopped, interrupted] = ids;

    ids.forEach((id) => {
      runtime.child(id).abortHangs = true;
    });

    const stopping = runner.stop(stopped);

    vi.advanceTimersByTime(5_000);

    expect(await stopping).toBe(true);
    expect(registry.get(stopped)?.state).toBe("stopped");
    expect(runtime.child(stopped).disposed).toBe(true);

    const shutdown = host.shutdown("quit");

    await flush();
    vi.advanceTimersByTime(5_000);
    await shutdown;

    expect(registry.get(interrupted)?.state).toBe("failed");
    expect(runtime.child(interrupted).disposed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes at once like a plain stop when the grace period is zero", async () => {
    const { registry, runner, runtime, host, ids } = await setup(1, { stopGraceSeconds: 0 });
    const [id] = ids;

    await runner.stop(id);
    await flush();

    expect(registry.get(id)).toMatchObject({ state: "stopped", error: "stopped by the user" });
    expect(runtime.child(id).aborted).toBe(true);
    expect(wakeTexts(host)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes as handoff and wakes once when a handoff is written during grace", async () => {
    const { registry, runner, runtime, host, send, ids } = await setup();
    const [id] = ids;
    const record = registry.get(id);

    await runner.stop(id);
    await send(id, "write your handoff");

    registry.update(id, { handoffRequested: true });
    mkdirSync(dirname(record?.handoffPath ?? ""), { recursive: true });
    writeFileSync(record?.handoffPath ?? "", "# Handoff\nstatus: partial\n");
    runtime.child(id).finish("handoff written");
    await flush();

    expect(registry.get(id)?.state).toBe("handoff");
    expect(wakeTexts(host)).toHaveLength(1);
    expect(wakeTexts(host)[0]).toContain("Handoff file:");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes as failed when a limit aborts a run during grace", async () => {
    const { registry, runner, runtime, host, send, ids } = await setup();
    const [id] = ids;

    await runner.stop(id);
    await send(id, "keep going");
    await runner.abort(id, "context hard limit reached before the handoff was finished");
    await flush();

    expect(registry.get(id)).toMatchObject({
      state: "failed",
      error: "context hard limit reached before the handoff was finished",
    });
    expect(runtime.child(id).disposed).toBe(true);
    expect(wakeTexts(host)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a queued agent at once since it has nothing to answer with", async () => {
    const { registry, runner, host, ids } = await setup(2, { maxConcurrent: 1 });
    const queued = ids[1];

    expect(registry.get(queued)?.state).toBe("queued");

    await runner.stop(queued);

    expect(registry.get(queued)?.state).toBe("stopped");
    expect(wakeTexts(host)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects messages once the grace period has closed the agent", async () => {
    const { runner, send, ids } = await setup();
    const [id] = ids;

    await runner.stop(id);
    vi.advanceTimersByTime(GRACE_MS);
    await flush();

    const result = await send(id, "one more thing");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("is closed (stopped)");
  });
});
