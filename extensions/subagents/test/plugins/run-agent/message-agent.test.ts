import { describe, expect, it } from "vitest";
import { formatRoutedMessage } from "../../../../../core/adapter/route.ts";
import { parseSessionLines } from "../../../../../core/adapter/session-file.ts";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { MessageAgentParams, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";

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
        { agent: "explorer", task: "one" },
        { agent: "explorer", task: "two" },
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

  it("uses followUp while the agent is in the stop grace state", async () => {
    const { registry, runtime, send } = await setup();
    const [record] = registry.list();

    registry.update(record.id, { state: "grace" });

    const result = await send(record.id, "what did you find so far?");

    expect(result.details?.delivery).toBe("followUp");
    expect(runtime.child(record.id).messages[0].delivery).toBe("followUp");
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
      agent: "explorer",
      task: "nested",
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
