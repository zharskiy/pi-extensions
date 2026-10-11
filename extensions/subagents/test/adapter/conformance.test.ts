import * as pi from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { childSettings, createChildExtension } from "../../src/adapter/pi-child.ts";

const PINNED_PI_VERSION = "1.1.0";

type Handler = (event: unknown) => unknown;

const fakeExtensionApi = () => {
  const handlers = new Map<string, Handler[]>();
  const entries: { customType: string; data: unknown }[] = [];

  const api = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  };

  const fire = (event: string, payload: unknown) =>
    (handlers.get(event) ?? []).map((handler) => handler(payload));

  return { api, entries, fire };
};

describe("pi adapter conformance", () => {
  it(`is pinned to pi ${PINNED_PI_VERSION}`, () => {
    expect(pi.VERSION).toBe(PINNED_PI_VERSION);
  });

  it("finds every pi export the adapter uses", () => {
    const required = [
      "createAgentSession",
      "DefaultResourceLoader",
      "SessionManager",
      "SettingsManager",
      "ModelRuntime",
      "AssistantMessageComponent",
      "UserMessageComponent",
      "ToolExecutionComponent",
      "CustomMessageComponent",
      "createBashToolDefinition",
      "createEditToolDefinition",
      "createFindToolDefinition",
      "createGrepToolDefinition",
      "createLsToolDefinition",
      "createPowerShellToolDefinition",
      "createReadToolDefinition",
      "createWriteToolDefinition",
      "getAgentDir",
      "getMarkdownTheme",
      "initTheme",
      "keyText",
      "getDocsPath",
      "getExamplesPath",
      "getReadmePath",
    ];

    const requiredTui = ["Container", "Key", "matchesKey", "ScrollView", "Text", "truncateToWidth"];

    expect(required.filter((name) => !(name in pi))).toEqual([]);
    expect(requiredTui.filter((name) => !(name in tui))).toEqual([]);
  });

  it("exposes the model registry methods the model resolver reads", () => {
    const methods = ["getAll", "find", "hasConfiguredAuth"];

    expect(
      methods.filter((name) => typeof Reflect.get(pi.ModelRegistry.prototype, name) !== "function"),
    ).toEqual([]);
  });

  it("gives children in-memory settings with compaction off, a reserve and no cache warming", () => {
    const snapshot = { compaction: { enabled: true, keepRecentTokens: 20_000 }, defaultProvider: "openai" };
    const settings = pi.SettingsManager.inMemory(childSettings(snapshot, 16_384), { projectTrusted: false });

    expect(settings.getCompactionEnabled()).toBe(false);
    expect(settings.getCompactionReserveTokens()).toBe(16_384);
    expect(childSettings(snapshot, 16_384)).toMatchObject({
      compaction: { enabled: false, reserveTokens: 16_384, keepRecentTokens: 20_000 },
      cacheWarming: "off",
      defaultProvider: "openai",
    });
  });

  it("cancels every compaction attempt inside a child and reports it", () => {
    const events: string[] = [];
    const { api, fire } = fakeExtensionApi();

    createChildExtension("a1", (event) => events.push(event.type), "openai/x")(api as never);

    expect(fire("session_before_compact", { reason: "threshold" })).toEqual([{ cancel: true }]);
    expect(fire("session_before_compact", { reason: "overflow" })).toEqual([{ cancel: true }]);
    expect(events).toEqual(["compaction_blocked", "compaction_blocked"]);
  });

  it("records the first provider request once as the prompt record", () => {
    const { api, entries, fire } = fakeExtensionApi();

    createChildExtension("a1", () => {}, "openai/x")(api as never);

    fire("before_agent_start", {
      systemPromptOptions: {
        skills: [{ name: "s", description: "d", filePath: "/x" }],
        promptGuidelines: ["g1"],
        toolGuidelines: { read: ["g2"] },
      },
    });
    fire("before_provider_request", { payload: { model: "x", n: 1 } });
    fire("before_provider_request", { payload: { model: "x", n: 2 } });

    expect(entries).toEqual([
      {
        customType: "pi-subagents:prompt-record",
        data: {
          agentId: "a1",
          model: "openai/x",
          skills: [{ name: "s", description: "d" }],
          guidelines: ["g1", "g2"],
          providerPayload: { model: "x", n: 1 },
        },
      },
    ]);
  });
});
