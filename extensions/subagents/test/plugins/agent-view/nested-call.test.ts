import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionRecord, ToolSpec, ViewComponent } from "../../../../../core/adapter/contract.ts";
import { parseSessionLines, promptRecordEntry } from "../../../../../core/adapter/session-file.ts";
import { initRenderKeys, initRenderTheme } from "../../../../../core/test/adapter/render-theme.ts";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import { NAMESPACE } from "../../../src/model/paths.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentStatusPlugin } from "../../../src/plugins/agent-status/index.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { runAgentPlugin } from "../../../src/plugins/run-agent/index.ts";
import type { RunAgentDetails, RunAgentParams } from "../../../src/plugins/run-agent/tools.ts";
import { createHarness } from "../../helpers/harness.ts";
import { fakeOverlayApi, plain } from "../../helpers/overlay.ts";

const RECORD_ENTRY = promptRecordEntry(NAMESPACE);

initRenderTheme();
initRenderKeys();

const views: ViewComponent[] = [];

afterEach(() => {
  views.splice(0).forEach((view) => {
    view.dispose?.();
  });
});

const line = (message: Record<string, unknown>) => JSON.stringify({ type: "message", message });

const ARGS = {
  agents: [
    { agent: "explorer", task: "find callers" },
    { agent: "explorer", task: "find tests" },
  ],
};

const nestedSession = (args: Record<string, unknown>, result?: { text: string; details?: RunAgentDetails }) =>
  parseSessionLines(
    [
      line({ role: "user", content: [{ type: "text", text: "Task from main (agent id explorer-1): Nest" }] }),
      line({
        role: "assistant",
        content: [{ type: "toolCall", id: "ra1", name: "run_agent", arguments: args }],
        stopReason: "toolUse",
      }),
      ...(result
        ? [
            line({
              role: "toolResult",
              toolCallId: "ra1",
              toolName: "run_agent",
              content: [{ type: "text", text: result.text }],
              details: result.details,
              isError: false,
            }),
          ]
        : []),
    ],
    RECORD_ENTRY,
  );

const setup = async (wait: boolean, args: Record<string, unknown> = { ...ARGS, wait }) => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    runAgentPlugin,
    agentStatusPlugin,
    agentViewPlugin,
  ]);
  const registry = harness.services.require("registry");

  await harness.host
    .tool<RunAgentParams, RunAgentDetails>("run_agent")
    .execute({ agents: [{ agent: "general", task: "nest" }] }, { toolCallId: "ra1", update: () => {} });
  await flush();

  const parent = registry.list()[0];
  const runAgent = harness.runtime
    .child(parent.id)
    .spec.customTools?.find((spec) => spec.name === "run_agent") as unknown as ToolSpec<
    RunAgentParams,
    RunAgentDetails
  >;
  const running = runAgent.execute({ ...ARGS, wait }, { toolCallId: "ra1", update: () => {} });

  await flush();

  const file = join(harness.root, "parent.jsonl");

  const show = (session: SessionRecord, content: string) => {
    writeFileSync(file, content);
    harness.runtime.sessions.set(file, session);
  };

  show(nestedSession(args), "");
  registry.update(parent.id, { sessionFile: file });

  const open = async () => {
    await harness.services.require("agentView").open(parent.id, { from: "command" });

    const factory = harness.host.overlays.at(-1);

    if (!factory) {
      throw new Error("no overlay opened");
    }

    const view = factory(fakeOverlayApi(200).api);

    views.push(view);

    return () => plain(view.render(100)).join("\n");
  };

  const nested = registry.list().filter((record) => record.callerId === parent.id);

  return { harness, running, nested, show, open };
};

describe("agent view nested run_agent calls", () => {
  it("draws a background nested call that is still executing with its live rows", async () => {
    const { open } = await setup(false);
    const shown = (await open())();

    expect(shown).toContain(" 2 background explorer agents launched (↓ to manage · ← to list)");
    expect(shown).toContain("explorer (find callers)");
    expect(shown).toContain("explorer (find tests)");
    expect(shown).toContain("Initializing…");
  });

  it("draws a waiting nested call while its batch runs and its final block once the result is written", async () => {
    const { harness, running, nested, show, open } = await setup(true);
    const text = await open();

    expect(text()).toContain(" 2 explorer agents launched");
    expect(text()).toContain("Initializing…");

    nested.forEach((record) => {
      harness.runtime.child(record.id).finish(`${record.id} done`);
    });

    const result = await running;

    await flush();
    expect(text()).toContain(" 2 explorer agents launched");
    expect(text()).toContain("Done · 0 tool uses");

    show(nestedSession({ ...ARGS, wait: true }, result), "written");

    const final = (await open())();

    expect(final).toContain(" 2 explorer agents finished");
    expect(final).toContain("Done · 0 tool uses");
  });

  it("draws the live block when the saved arguments carry a null optional field", async () => {
    const { open } = await setup(false, { ...ARGS, wait: null });
    const shown = (await open())();

    expect(shown).toContain(" 2 background explorer agents launched");
    expect(shown).toContain("Initializing…");
  });
});
