import { describe, expect, it } from "vitest";
import { createFakeAgentRuntime, createFakeHost } from "../../../test/framework/index.ts";
import type { Plugin } from "../../shared/index.ts";
import { createExtensionManager } from "../extension-manager.ts";

type Events = { ping: { from: string } };

type Services = { counter: { next(): number } };

type Settings = { label: string };

type TestPlugin = Plugin<Events, Services, Settings>;

const stub = (id: string, requires: string[] = [], log: string[] = []): TestPlugin => ({
  id,
  requires,
  enable: () => {
    log.push(`enable ${id}`);
    return () => {
      log.push(`disable ${id}`);
    };
  },
});

const managerOf = (plugins: TestPlugin[], disabled: string[] = []) => {
  const host = createFakeHost();
  const errors: unknown[] = [];

  const manager = createExtensionManager({
    host,
    runtime: createFakeAgentRuntime(),
    settings: { label: "test" },
    plugins,
    paths: { root: "/ext", agentDir: "/agent" },
    disabled,
    onError: (error) => errors.push(error),
  });

  return { host, manager, errors };
};

describe("extension manager", () => {
  it("enables plugins in the order of their requirements", () => {
    const log: string[] = [];

    managerOf([stub("c", ["b"], log), stub("b", ["a"], log), stub("a", [], log)]);

    expect(log).toEqual(["enable a", "enable b", "enable c"]);
  });

  it("skips disabled plugins and the plugins that need them, and disables in reverse order", async () => {
    const log: string[] = [];
    const some = managerOf([stub("a", [], log), stub("b", ["a"], log), stub("c", [], log)], ["a"]);

    expect(some.host.notices).toEqual([]);

    some.host.start();

    expect(some.host.notices).toEqual([
      { message: "plugins skipped because a plugin they need is off: b (needs a)", level: "warning" },
    ]);

    const all = managerOf([stub("x", [], log), stub("y", ["x"], log)]);

    await all.manager.disableAll();

    expect(log).toEqual(["enable c", "enable x", "enable y", "disable y", "disable x"]);
  });

  it("rejects dependency cycles", () => {
    expect(() => managerOf([stub("a", ["b"]), stub("b", ["a"])])).toThrow(/cycle/);
  });

  it("hands each plugin the host, typed bus, services, settings, root and paths", () => {
    const seen: string[] = [];

    const provider: TestPlugin = {
      id: "provider",
      enable: ({ services, settings, root, paths }) => {
        let count = 0;

        services.provide("counter", { next: () => ++count });
        seen.push(`${settings.label} ${root} ${paths.root} ${paths.agentDir}`);

        return undefined;
      },
    };

    const consumer: TestPlugin = {
      id: "consumer",
      requires: ["provider"],
      enable: ({ host, bus, services }) => {
        bus.on("ping", ({ from }) => seen.push(`ping from ${from} #${services.require("counter").next()}`));
        host.registerCommand("hello", { description: "hi", run: () => {} });
        host.registerTool({
          name: "greet",
          label: "Greet",
          description: "greets",
          parameters: {},
          execute: async () => ({ text: "hi" }),
        });

        return undefined;
      },
    };

    const { manager, host } = managerOf([consumer, provider]);

    manager.bus.emit("ping", { from: "test" });

    expect(seen).toEqual(["test /ext /ext /agent", "ping from test #1"]);
    expect([...host.commands.keys()]).toEqual(["hello"]);
    expect([...host.tools.keys()]).toEqual(["greet"]);
    expect(manager.services.has("counter")).toBe(true);
  });

  it("names the missing service and isolates disable errors", async () => {
    const failing: TestPlugin = {
      id: "failing",
      enable: () => () => {
        throw new Error("boom");
      },
    };

    const { manager, errors } = managerOf([failing]);

    expect(() => manager.services.require("counter")).toThrow(/service "counter" is not provided/);

    await manager.disableAll();

    expect(errors).toHaveLength(1);
  });
});
