import { describe, expect, it } from "vitest";
import type { RunMode } from "../../../platform/pi-adapter/index.ts";
import { createFakeHost } from "../../../test/framework/index.ts";
import { conversationOnly } from "../core/conversation-host.ts";

const setup = (mode: RunMode) => {
  const fake = createFakeHost({ mode });
  const host = conversationOnly(fake);
  const seen: string[] = [];

  host.onSessionStart((info) => seen.push(`start ${info.mode}`));
  host.onTurnEnd((context) => seen.push(`turn ${context.tokens}`));
  host.onIdle(() => seen.push("idle"));
  host.registerCommand("handoff", { description: "switch", run: () => void seen.push("command") });

  return { fake, host, seen };
};

describe("conversationOnly", () => {
  it("forwards session events and commands in tui and rpc", async () => {
    const tui = setup("tui");

    tui.fake.start();
    tui.fake.turnEnd({ tokens: 1_000, window: 100_000 });
    tui.fake.settle();
    await tui.fake.runCommand("handoff");

    expect(tui.seen).toEqual(["start tui", "turn 1000", "idle", "command"]);
  });

  it("ignores every session event and command in print and json runs", async () => {
    const runs = (["print", "json"] as const).map(setup);

    await Promise.all(
      runs.map(async ({ fake }) => {
        fake.start();
        fake.turnEnd({ tokens: 1_000, window: 100_000 });
        fake.settle();
        await fake.runCommand("handoff");
      }),
    );

    runs.forEach(({ seen }) => {
      expect(seen).toEqual([]);
    });
  });
});
