import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionFactory,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Host } from "../../adapter/contract.ts";
import { createPiExtension } from "../../adapter/pi-adapter.ts";
import { describeLive, LIVE_TIMEOUT_MS, liveModel, reportCost, sessionLines, waitUntil } from "./live.ts";

type Line = {
  type?: string;
  customType?: string;
  display?: boolean;
  message?: { role?: string; sections?: unknown; content?: unknown; usage?: { cost?: { total?: number } } };
};

const userText = (line: Line) => {
  const content = line.message?.content;

  if (typeof content === "string") {
    return content;
  }

  return Array.isArray(content)
    ? content
        .filter((part): part is { type: "text"; text: string } => part?.type === "text")
        .map((part) => part.text)
        .join("")
    : "";
};

describeLive("live wake", () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pi-wake-live-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "keeps the replaced main prompt identical across a wake-triggered run",
    async () => {
      const marker = `WAKE-TEST-PROMPT ${randomUUID()}`;
      const cwd = join(root, "project");
      const prompts: string[] = [];
      const payloads: string[] = [];
      let host: Host | undefined;

      mkdirSync(cwd, { recursive: true });

      const wake = createPiExtension(
        (booted) => {
          host = booted;
          booted.setMainPrompt(marker);
          booted.registerTool({
            name: "noop",
            label: "noop",
            description: "Does nothing and returns ok.",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ text: "ok" }),
          });
        },
        { root, namespace: "wake-test" },
      );

      const recorder: ExtensionFactory = (pi) => {
        pi.on("before_provider_request", (event, ctx) => {
          prompts.push(ctx.getSystemPrompt());
          payloads.push(JSON.stringify(event.payload));
        });
      };

      const { model, thinking } = liveModel();
      const agentDir = getAgentDir();
      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noSkills: true,
        extensionFactories: [
          { name: "wake", factory: wake },
          { name: "wake-recorder", factory: recorder },
        ],
      });

      await loader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime: await ModelRuntime.create(),
        model,
        thinkingLevel: (thinking ?? "off") as never,
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.create(cwd, join(root, "sessions")),
      });

      let settled = 0;

      session.subscribe((event) => {
        if (event.type === "agent_settled") {
          settled += 1;
        }
      });

      try {
        await session.bindExtensions({ mode: "print" });

        await session.prompt("Call the noop tool twice, then reply with the single word ok.");
        await waitUntil(() => settled >= 1, LIVE_TIMEOUT_MS, "the first run to settle");

        host?.sendHiddenMessage(
          {
            customType: "wake-test",
            text: "Call the noop tool once more, then reply with the single word done.",
          },
          "Agents finished",
        );

        await waitUntil(() => settled >= 2, LIVE_TIMEOUT_MS, "the wake run to settle");

        const file = session.sessionFile;

        expect(file).toBeDefined();

        const lines = sessionLines(String(file)) as Line[];
        const messages = lines.filter((line) => line.type === "message" || line.type === "custom_message");
        const firstUser = messages.findIndex((line) => line.message?.role === "user");
        const wakeIndex = messages.findIndex(
          (line) => line.type === "custom_message" && line.customType === "wake-test",
        );
        const systems = messages
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.message?.role === "system" && line.message.sections !== undefined);
        const cost = lines.reduce(
          (sum, line) =>
            sum + (line.message?.role === "assistant" ? (line.message.usage?.cost?.total ?? 0) : 0),
          0,
        );

        reportCost("wake", cost);

        expect(prompts.length).toBeGreaterThanOrEqual(4);
        expect(new Set(prompts).size).toBe(1);
        expect(prompts[0]).toContain(marker);
        expect(payloads.every((payload) => payload.includes(marker))).toBe(true);
        expect(systems).toHaveLength(1);
        expect(systems.filter(({ index }) => index > firstUser)).toEqual([]);
        expect(wakeIndex).toBeGreaterThan(firstUser);
        expect(messages[wakeIndex]?.display).toBe(false);
        expect(messages[wakeIndex - 1]?.message?.role).toBe("user");
        expect(userText(messages[wakeIndex - 1] ?? {})).toBe("Agents finished");
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );
});
