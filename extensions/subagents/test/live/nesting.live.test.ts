import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeLive, LIVE_TIMEOUT_MS, quiet, sessionLines } from "../../../../core/test/adapter/live.ts";
import { wakeTexts } from "../helpers/harness.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";

const SECRET = randomUUID().slice(0, 8);

describeLive("live nested agents", () => {
  let live: LiveHarness;

  beforeAll(() => {
    live = createLiveHarness("nesting", {
      agents: {
        general: {
          from: "general",
          fields: { tools: "[]", skills: "[]", subagents: "[scout]" },
        },
        scout: { from: "scout" },
      },
    });

    writeFileSync(join(live.project, "secret.txt"), `${SECRET}\n`);
  });

  afterAll(async () => {
    await live?.close();
  });

  it("lets general start an scout whose result wakes general only, and general wakes the main session once", async () => {
    const generalId = await live.run(
      "general",
      "Call run_agent once, without the wait option, to start exactly one scout agent with the task: read secret.txt in your current working directory and reply with its content only. Then end your turn. When you are woken with the scout's result, reply with the scout's answer only.",
    );

    await live.waitForWakes(1, 2 * LIVE_TIMEOUT_MS);
    await quiet(2_000);

    const general = live.registry.get(generalId);
    const scout = live.registry.list().find((record) => record.callerId === generalId);
    const scoutId = scout?.id ?? "missing";

    const wakes = sessionLines(general?.sessionFile ?? "").filter(
      (line) => line.message?.role === "user" && JSON.stringify(line.message.content).includes(scoutId),
    );

    expect(general?.state).toBe("done");
    expect(general?.resultText).toContain(SECRET);
    expect(scout?.agent).toBe("scout");
    expect(scout?.depth).toBe((general?.depth ?? 0) + 1);
    expect(scout?.state).toBe("done");
    expect(wakes).toHaveLength(1);
    expect(wakeTexts(live.host)).toHaveLength(1);
    expect(wakeTexts(live.host)[0]).toContain(generalId);
    expect(wakeTexts(live.host)[0]).not.toContain(scoutId);
  });
});
