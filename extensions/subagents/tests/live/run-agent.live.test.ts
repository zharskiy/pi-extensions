import { afterAll, beforeAll, expect, it } from "vitest";
import { hiddenMessageTexts } from "../../../../test-framework/index.ts";
import { sessionHeader } from "../../../../test-framework/pi/index.ts";
import { describeLive } from "../../../../test-framework/pi/live/index.ts";
import { createLiveHarness, type LiveHarness } from "../support/live-harness.ts";

const TINY_TASK = "Reply with the single word OK. Do not call any tool.";

describeLive("live run_agent", () => {
  let live: LiveHarness;

  beforeAll(() => {
    live = createLiveHarness("run-agent", {
      agents: {
        scout: { from: "scout" },
      },
    });
  });

  afterAll(async () => {
    await live?.close();
  });

  it("runs one scout to done with a result, a cost and a linked session file", async () => {
    const id = await live.run("scout", TINY_TASK);

    await live.waitForWakes(1);

    const record = live.registry.get(id);

    expect(record?.state).toBe("done");
    expect(record?.resultText).toContain("OK");
    expect(live.usage.get(id)?.cost.total ?? 0).toBeGreaterThan(0);
    expect(sessionHeader(record?.sessionFile ?? "")?.parentSession).toBe(live.host.info.file);
    expect(hiddenMessageTexts(live.host)[0]).toContain(id);
  });
});
