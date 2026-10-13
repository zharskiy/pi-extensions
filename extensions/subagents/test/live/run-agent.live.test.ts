import { afterAll, beforeAll, expect, it } from "vitest";
import { describeLive, sessionHeader } from "../../../../core/test/adapter/live.ts";
import { wakeTexts } from "../helpers/harness.ts";
import { createLiveHarness, type LiveHarness } from "../helpers/live.ts";

const TINY_TASK = "Reply with the single word OK. Do not call any tool.";

describeLive("live run_agent", () => {
  let live: LiveHarness;

  beforeAll(() => {
    live = createLiveHarness("run-agent", {
      agents: {
        explorer: { from: "explorer" },
      },
    });
  });

  afterAll(async () => {
    await live?.close();
  });

  it("runs one explorer to done with a result, a cost and a linked session file", async () => {
    const id = await live.run("explorer", TINY_TASK);

    await live.waitForWakes(1);

    const record = live.registry.get(id);

    expect(record?.state).toBe("done");
    expect(record?.resultText).toContain("OK");
    expect(live.usage.get(id)?.cost.total ?? 0).toBeGreaterThan(0);
    expect(sessionHeader(record?.sessionFile ?? "")?.parentSession).toBe(live.host.info.file);
    expect(wakeTexts(live.host)[0]).toContain(id);
  });
});
