import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../../../../core/adapter/contract.ts";
import { flush } from "../../../../../core/test/helpers/fakes.ts";
import type { AgentRecord } from "../../../src/model/types.ts";
import { agentDefinitionsPlugin } from "../../../src/plugins/agent-definitions/index.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { agentSetupPlugin } from "../../../src/plugins/agent-setup/index.ts";
import { agentViewPlugin } from "../../../src/plugins/agent-view/index.ts";
import { plugins } from "../../../src/plugins.ts";
import { createHarness } from "../../helpers/harness.ts";
import { openLastOverlay } from "../../helpers/overlay.ts";
import { newAgentInput } from "../../helpers/records.ts";

const digit = (char: string): KeyPress => ({ name: "other", char });

const setup = () => {
  const harness = createHarness([
    agentRegistryPlugin,
    agentDefinitionsPlugin,
    agentSetupPlugin,
    agentViewPlugin,
  ]);
  const registry = harness.services.require("registry");

  const create = (state: AgentRecord["state"]) => {
    const record = registry.create(newAgentInput(harness.root, {}));

    if (state === "done") {
      registry.close(record.id, { state });
    } else {
      registry.update(record.id, { state });
    }

    return record;
  };

  return { ...harness, registry, create };
};

describe("/agents menu", () => {
  it("offers view, setup and create with their descriptions", async () => {
    const { host } = setup();
    const running = host.runCommand("agents");
    const text = host.form().render(120).join("\n");

    expect(text).toContain("Agents");
    expect(text).toMatch(/view\s+agents list\n/);
    expect(text).toMatch(/setup\s+model, thinking and skills per agent/);
    expect(text).toMatch(/create\s+new agent; the main session asks what it is for and writes it/);
    expect(text).toContain("↑↓ to select · 1-9 to pick · enter to choose · esc to cancel");

    host.form().press({ name: "escape" });
    await running;
  });

  it("counts running and finished agents beside view", async () => {
    const { host, create } = setup();

    create("running");
    create("running");
    create("done");

    const running = host.runCommand("agents");

    expect(host.form().render(120).join("\n")).toContain("agents list · 2 running · 1 finished");

    host.form().press({ name: "escape" });
    await running;
  });

  it("counts the same finished agents as the list subtitle", async () => {
    const { host, registry, root } = setup();
    const lead = registry.create(newAgentInput(root, {}));
    const child = registry.create(newAgentInput(root, { callerId: lead.id }));
    const first = registry.create(newAgentInput(root, {}));
    const second = registry.create(newAgentInput(root, { chainIndex: 2, predecessorId: first.id }));

    registry.update(lead.id, { state: "running" });
    registry.close(child.id, { state: "done" });
    registry.close(first.id, { state: "handoff", successorId: second.id });
    registry.close(second.id, { state: "done" });

    const menu = host.runCommand("agents");

    expect(host.form().render(120).join("\n")).toContain("agents list · 1 running · 1 finished");

    host.form().press({ name: "enter" });
    await menu;

    expect(openLastOverlay(host).lines()[1]).toBe(" Agents · 1 running · 1 finished");
  });

  it("opens the list on view, with Enter or 1", async () => {
    const { host } = setup();
    const first = host.runCommand("agents");

    host.form().press({ name: "enter" });
    await first;

    expect(host.overlays).toHaveLength(1);

    const second = host.runCommand("agents");

    host.form().press(digit("1"));
    await second;

    expect(host.overlays).toHaveLength(2);
    expect(host.sent).toEqual([]);
  });

  it("opens the setup form on 2 and sends the create brief on 3", async () => {
    const { host } = setup();
    const setupRun = host.runCommand("agents");

    host.form().press(digit("2"));
    await flush();

    expect(host.forms).toHaveLength(2);
    expect(host.form().render(120).join("\n")).toContain("Submit");

    host.form().press({ name: "escape" });
    await setupRun;

    const createRun = host.runCommand("agents");

    host.form().press(digit("3"));
    await createRun;

    expect(host.hidden).toHaveLength(1);
    expect(host.hidden[0]?.message.text).toContain("The user ran /agents create and wants a new agent");
    expect(host.overlays).toHaveLength(0);
  });

  it("does nothing on Esc", async () => {
    const { host } = setup();
    const running = host.runCommand("agents");

    host.form().press({ name: "escape" });
    await running;

    expect(host.overlays).toHaveLength(0);
    expect(host.notices).toEqual([]);
    expect(host.sent).toEqual([]);
  });

  it("opens the list directly when agent-setup is disabled", async () => {
    const harness = createHarness(plugins, { overrides: { disabledPlugins: ["agent-setup"] } });

    await harness.host.runCommand("agents");

    expect(harness.host.forms).toHaveLength(0);
    expect(harness.host.overlays).toHaveLength(1);
  });

  it("opens the list with /agents view and with ← on an empty prompt, without a menu", async () => {
    const { host } = setup();

    await host.runCommand("agents", "view");

    expect(host.overlays).toHaveLength(1);
    expect(host.pressEmptyLeft()).toBe(true);
    expect(host.overlays).toHaveLength(2);
    expect(host.forms).toHaveLength(0);
  });

  it("says the list needs the terminal outside the TUI", async () => {
    const { host } = setup();

    host.info.mode = "rpc";
    await host.runCommand("agents");
    await host.runCommand("agents", "view");

    expect(host.forms).toHaveLength(0);
    expect(host.overlays).toHaveLength(0);
    expect(host.notices).toEqual(
      Array.from({ length: 2 }, () => ({
        message:
          "pi-subagents: the agents list needs the interactive terminal; /agents create works in any mode",
        level: "info",
      })),
    );
  });

  it("completes view for the prefix v", () => {
    const { host } = setup();

    expect(host.commands.get("agents")?.complete?.("v")).toEqual([
      { value: "view", label: "view · agents list" },
    ]);
  });
});
