import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, expect, it } from "vitest";
import { pause, reportCost, waitUntil } from "../../../../test/framework/index.ts";
import { sessionLines } from "../../../../test/framework/pi/index.ts";
import { describeLive, LIVE_TIMEOUT_MS, openPiSession } from "../../../../test/framework/pi/live/index.ts";
import type { Host } from "../../index.ts";
import { createPiExtension } from "../../index.ts";

type Line = {
  type?: string;
  customType?: string;
  display?: boolean;
  message?: { role?: string; sections?: unknown; content?: unknown; usage?: { cost?: { total?: number } } };
};

const assistantCost = (lines: Line[]) =>
  lines.reduce(
    (sum, line) => sum + (line.message?.role === "assistant" ? (line.message.usage?.cost?.total ?? 0) : 0),
    0,
  );

describeLive("live wake", () => {
  let root = "";

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pi-wake-live-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(
    "keeps the replaced main prompt across a hidden wake-triggered run",
    async () => {
      const marker = `WAKE-TEST-PROMPT ${randomUUID()}`;
      const prompts: string[] = [];
      const payloads: string[] = [];
      let host: Host | undefined;

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

      const { session, settledRuns } = await openPiSession({
        root: join(root, "prompt"),
        extensions: [
          { name: "wake", factory: wake },
          { name: "wake-recorder", factory: recorder },
        ],
      });

      try {
        await session.prompt("Call the noop tool twice, then reply with the single word ok.");
        await waitUntil(() => settledRuns() >= 1, LIVE_TIMEOUT_MS, "the first run to settle");

        host?.sendHiddenMessage({
          customType: "wake-test",
          text: "Call the noop tool once more, then reply with the single word done.",
        });

        await waitUntil(() => settledRuns() >= 2, LIVE_TIMEOUT_MS, "the wake run to settle");

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
        reportCost("wake", assistantCost(lines));

        expect(prompts.length).toBeGreaterThanOrEqual(4);
        expect(new Set(prompts).size).toBe(1);
        expect(prompts[0]).toContain(marker);
        expect(payloads.every((payload) => payload.includes(marker))).toBe(true);
        expect(systems).toHaveLength(1);
        expect(systems.filter(({ index }) => index > firstUser)).toEqual([]);
        expect(wakeIndex).toBeGreaterThan(firstUser);
        expect(messages[wakeIndex]?.display).toBe(false);
        expect(messages.filter((line) => line.message?.role === "user")).toHaveLength(1);
        expect(
          messages.slice(wakeIndex + 1).filter((line) => line.message?.role === "assistant").length,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "delivers a hidden message sent while a run starts inside that run",
    async () => {
      const marker = `WAKE-TEST-HELD ${randomUUID()}`;
      const payloads: string[] = [];
      let host: Host | undefined;
      let sent = false;

      const wake = createPiExtension(
        (booted) => {
          host = booted;
        },
        { root, namespace: "wake-test" },
      );

      const recorder: ExtensionFactory = (pi) => {
        pi.on("before_agent_start", () => {
          if (sent) {
            return;
          }

          sent = true;
          host?.sendHiddenMessage({
            customType: "wake-test",
            text: `${marker}: reply with the single word done.`,
          });
        });
        pi.on("before_provider_request", (event) => {
          payloads.push(JSON.stringify(event.payload));
        });
      };

      const { session, settledRuns } = await openPiSession({
        root: join(root, "held"),
        extensions: [
          { name: "wake", factory: wake },
          { name: "wake-recorder", factory: recorder },
        ],
      });

      try {
        await session.prompt("Reply with the single word ok.");
        await waitUntil(() => settledRuns() >= 1, LIVE_TIMEOUT_MS, "the run to settle");
        await pause(3_000);

        const file = session.sessionFile;

        expect(file).toBeDefined();

        const lines = sessionLines(String(file)) as Line[];
        const messages = lines.filter((line) => line.type === "message" || line.type === "custom_message");
        const firstUser = messages.findIndex((line) => line.message?.role === "user");
        const heldIndex = messages.findIndex(
          (line) => line.type === "custom_message" && line.customType === "wake-test",
        );

        reportCost("wake held", assistantCost(lines));

        expect(sent).toBe(true);
        expect(settledRuns()).toBe(1);
        expect(heldIndex).toBeGreaterThan(firstUser);
        expect(messages[heldIndex]?.display).toBe(false);
        expect(payloads.some((payload) => payload.includes(marker))).toBe(true);
        expect(
          messages.slice(heldIndex + 1).filter((line) => line.message?.role === "assistant").length,
        ).toBeGreaterThanOrEqual(1);
      } finally {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
