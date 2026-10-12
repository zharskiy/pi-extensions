import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeLive, LIVE_TIMEOUT_MS, quiet, sessionLines } from "../../../../core/test/adapter/live.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";

const SECRET = randomUUID().slice(0, 8);

describeLive("live nested agents", () => {
  let live: LiveHarness;

  beforeAll(() => {
    live = createLiveHarness("nesting", {
      agents: {
        general: {
          from: "general",
          fields: { tools: "[]", skills: "[]", subagents: "[explorer]" },
        },
        explorer: { from: "explorer" },
      },
    });

    writeFileSync(join(live.project, "secret.txt"), `${SECRET}\n`);
  });

  afterAll(async () => {
    await live?.close();
  });

  it("lets general start an explorer whose result wakes general only, and general wakes the main session once", async () => {
    const generalId = await live.run(
      "general",
      "Call run_agent once, without the wait option, to start exactly one explorer agent with the task: read secret.txt in your current working directory and reply with its content only. Then end your turn. When you are woken with the explorer's result, reply with the explorer's answer only.",
    );

    await live.waitForWakes(1, 2 * LIVE_TIMEOUT_MS);
    await quiet(2_000);

    const general = live.registry.get(generalId);
    const explorer = live.registry.list().find((record) => record.callerId === generalId);
    const explorerId = explorer?.id ?? "missing";

    const wakes = sessionLines(general?.sessionFile ?? "").filter(
      (line) => line.message?.role === "user" && JSON.stringify(line.message.content).includes(explorerId),
    );

    expect(general?.state).toBe("done");
    expect(general?.resultText).toContain(SECRET);
    expect(explorer?.agent).toBe("explorer");
    expect(explorer?.depth).toBe((general?.depth ?? 0) + 1);
    expect(explorer?.state).toBe("done");
    expect(wakes).toHaveLength(1);
    expect(live.host.sent).toHaveLength(1);
    expect(live.host.sent[0]).toContain(generalId);
    expect(live.host.sent[0]).not.toContain(explorerId);
  });
});
