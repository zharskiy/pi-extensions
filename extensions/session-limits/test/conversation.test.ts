import { describe, expect, it } from "vitest";
import type { RunMode } from "../../../core/adapter/contract.ts";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { conversationOnly, isConversation } from "../src/conversation.ts";

const setup = (mode: RunMode) => {
  const fake = createFakeHost({ mode });
  const host = conversationOnly(fake);
  const seen: string[] = [];

  host.onSessionStart((info) => seen.push(`start ${info.mode}`));
  host.onTurnEnd((context) => seen.push(`turn ${context.tokens}`));
  host.onIdle(() => seen.push("idle"));
  host.registerCommand("session-handoff", { description: "switch", run: () => void seen.push("command") });

  return { fake, host, seen };
};

describe("conversationOnly", () => {
  it("forwards session events and commands in tui and rpc", async () => {
    const tui = setup("tui");

    tui.fake.start();
    tui.fake.turnEnd({ tokens: 1_000, window: 100_000 });
    tui.fake.settle();
    await tui.fake.runCommand("session-handoff");

    expect(tui.seen).toEqual(["start tui", "turn 1000", "idle", "command"]);
    expect(tui.host.isIdle()).toBe(true);
    expect(tui.host.session()?.mode).toBe("tui");
    expect(isConversation(tui.host.session())).toBe(true);
    expect(isConversation({ ...tui.fake.info, mode: "rpc" })).toBe(true);
  });

  it("ignores every session event and command in print and json runs", async () => {
    const runs = (["print", "json"] as const).map(setup);

    await Promise.all(
      runs.map(async ({ fake }) => {
        fake.start();
        fake.turnEnd({ tokens: 1_000, window: 100_000 });
        fake.settle();
        await fake.runCommand("session-handoff");
      }),
    );

    runs.forEach(({ host, seen }) => {
      expect(seen).toEqual([]);
      expect(host.isIdle()).toBe(false);
      expect(host.session()).toBeUndefined();
    });
  });
});
