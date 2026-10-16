import { describe, expect, it } from "vitest";
import { formatRoutedMessage, parseSessionLines } from "../../../../../core/test/adapter/offline.ts";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentParams } from "../../../src/plugins/run-agent/render.ts";
import type { MessageAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness, wakeTexts } from "../../helpers/harness.ts";

const setup = async (maxConcurrent = 4) => {
  const harness = createHarness([agentRegistryPlugin, agentDefinitionsPlugin, runAgentPlugin], {
    maxConcurrent,
  });
  const runAgent = harness.host.tool<RunAgentParams, unknown>("run_agent");
  const messageAgent = harness.host.tool<MessageAgentParams, { delivery?: string }>("message_agent");
  const registry = harness.services.require("registry");

  await runAgent.execute(
    {
      agents: [
        { agent: "scout", task: "one" },
        { agent: "scout", task: "two" },
      ],
    },
    { update: () => {} },
  );
  await flush();

  const send = (id: string, message: string) => messageAgent.execute({ id, message }, { update: () => {} });

  return { ...harness, registry, send };
};

describe("message_agent", () => {
  it("steers a running agent and returns at once without a reply", async () => {
    const { registry, runtime, send } = await setup();
    const [record] = registry.list();
    const result = await send(record.id, "stop touching the auth module");

    expect(result.isError).toBeUndefined();
    expect(result.text).toBe(`Message delivered to ${record.id} (steer).`);
    expect(runtime.child(record.id).messages).toEqual([
      { message: { sender: "main", text: "stop touching the auth module" }, delivery: "steer" },
    ]);
  });

  it("answers a message in the stop grace period with a follow-up turn", async () => {
    const { registry, runtime, send, services, host } = await setup();
    const [record] = registry.list();

    await services.require("runner").stop(record.id);

    expect(registry.get(record.id)?.state).toBe("grace");

    const result = await send(record.id, "what did you find so far?");

    await flush();

    expect(result.details?.delivery).toBe("followUp");
    expect(runtime.child(record.id).messages[0].delivery).toBe("followUp");

    await host.shutdown();
  });

  it("runs a grace answer only once a slot is free and releases the slot when it settles", async () => {
    const { registry, runtime, send, services, host } = await setup(1);
    const [first, second] = registry.list();

    host.settle();
    await services.require("runner").stop(first.id);
    await flush();

    expect(registry.get(second.id)?.state).toBe("running");

    const result = await send(first.id, "what did you find so far?");

    await flush();

    expect(result.details?.delivery).toBe("followUp");
    expect(runtime.child(first.id).messages).toEqual([]);

    runtime.child(second.id).finish("second result");
    await flush();

    expect(runtime.child(first.id).messages.map((entry) => entry.delivery)).toEqual(["followUp"]);

    await send(first.id, "and the tests?");

    expect(runtime.child(first.id).messages.map((entry) => entry.delivery)).toEqual(["followUp", "steer"]);

    runtime.child(first.id).finish("the handler lives in src/auth.ts");
    await flush();

    expect(registry.get(first.id)?.state).toBe("grace");

    await services.require("runner").stop(first.id);
    await flush();

    expect(wakeTexts(host)).toHaveLength(1);

    await host
      .tool<RunAgentParams, unknown>("run_agent")
      .execute({ agents: [{ agent: "scout", task: "three" }] }, { update: () => {} });
    await flush();

    expect(registry.list()[2].state).toBe("running");

    await host.shutdown();
  });

  it("holds messages for a queued agent and steers them right after it starts", async () => {
    const { registry, runtime, send, host } = await setup(1);
    const [first, second] = registry.list();

    expect(second.state).toBe("queued");

    const held = await send(second.id, "also cover the tests");

    expect(held.text).toContain("(held)");

    host.settle();
    runtime.child(first.id).finish("done");
    await flush();

    expect(runtime.child(second.id).messages).toEqual([
      { message: { sender: "main", text: "also cover the tests" }, delivery: "steer" },
    ]);
  });

  it("rejects closed agents", async () => {
    const { registry, runtime, send, host } = await setup();
    const [record] = registry.list();

    host.settle();
    runtime.child(record.id).finish("result");

    const result = await send(record.id, "one more thing");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("is closed (done)");
    expect(runtime.child(record.id).messages).toEqual([]);
  });

  it("rejects callers that did not start the agent", async () => {
    const { registry, send } = await setup();
    const [record] = registry.list();

    const grandchild = registry.create({
      agent: "scout",
      description: "nested",
      callerId: record.id,
      depth: 3,
      batchId: "b-other",
      dir: record.dir,
      contextLimit: 100_000,
    });

    const result = await send(grandchild.id, "hello from main");

    expect(result.isError).toBe(true);
    expect(result.text).toBe(`Error: only the caller that started ${grandchild.id} may message it.`);
  });

  it("rejects unknown agents", async () => {
    const { send } = await setup();
    const result = await send("ghost-0000", "hi");

    expect(result.isError).toBe(true);
  });

  it("tags the message with its sender so it shows in the agent transcript", () => {
    const text = formatRoutedMessage({ sender: "main", text: "also cover the tests" });

    const session = parseSessionLines(
      [JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })],
      "pi-subagents:prompt-record",
    );

    expect(session.items).toEqual([{ kind: "user", text: "[message from main]\nalso cover the tests" }]);
  });
});
