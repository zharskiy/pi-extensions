import { describe, expect, it } from "vitest";
import { createManagedExtension } from "../../extension-manager/index.ts";
import type { Plugin } from "../../shared/index.ts";
import { createFakeAgentRuntime, createFakeHost, startExtension } from "../index.ts";

type Settings = { label: string };

const recorder = (seen: string[]): Plugin<never, unknown, Settings> => ({
  id: "recorder",
  enable: ({ host, settings, paths }) => {
    host.onSessionStart(() => {
      seen.push(`${settings.label} ${paths.root} ${paths.agentDir}`);
    });

    return () => {
      throw new Error("disable failed");
    };
  },
});

describe("startExtension", () => {
  it("boots a plugin list on the fake host with the host's agent dir", () => {
    const seen: string[] = [];
    const host = createFakeHost({ agentDir: "/agent" });

    startExtension({
      plugins: [recorder(seen)],
      settings: { label: "plugins" },
      root: "/ext",
      runtime: createFakeAgentRuntime(),
      host,
    });

    expect(seen).toEqual(["plugins /ext /agent"]);
  });

  it("boots a managed extension with settings overrides and captures its errors", async () => {
    const seen: string[] = [];
    const extension = createManagedExtension({
      namespace: "pi-harness",
      root: "/ext/harness",
      plugins: [recorder(seen)],
      settings: { defaults: () => ({ label: "default" }), schema: {}, file: "pi-harness.json" },
      onError: () => {
        throw new Error("the harness replaces onError");
      },
    });
    const harness = startExtension({
      extension,
      settings: { label: "override" },
      runtime: createFakeAgentRuntime(),
      host: createFakeHost({ agentDir: "/agent" }),
    });

    expect(harness.root).toBe("/ext/harness");
    expect(seen).toEqual(["override /ext/harness /agent"]);

    await harness.host.shutdown();

    expect(harness.errors).toHaveLength(1);
  });
});
