import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { hiddenMessageTexts, pause } from "../../../../test/framework/index.ts";
import { describeLive, LIVE_TIMEOUT_MS } from "../../../../test/framework/pi/live/index.ts";
import type { AgentRecord } from "../../core/model/agent-record.ts";
import { handoffService } from "../../core/model/handoff.ts";
import { createLiveHarness, type LiveHarness } from "../support/live-harness.ts";

const PARTS = 12;

const partText = (part: number) =>
  Array.from(
    { length: 24 },
    (_, line) =>
      `part ${part} line ${line + 1}: the quick brown fox jumps over the lazy dog ${part * 100 + line}`,
  ).join("\n");

const chainOf = (live: LiveHarness, first: AgentRecord): AgentRecord[] => {
  const next = first.successorId ? live.registry.get(first.successorId) : undefined;

  return next ? [first, ...chainOf(live, next)] : [first];
};

describeLive("live context limit handoff", () => {
  let live: LiveHarness;

  beforeAll(() => {
    live = createLiveHarness("handoff", {
      agents: {
        "implementer-tight": {
          from: "implementer",
          fields: { tools: "[read, ls, write]", limit: "5000" },
        },
      },
      settings: { hardContextRatio: 2 },
    });

    Array.from({ length: PARTS }, (_, index) => index + 1).forEach((part) => {
      writeFileSync(join(live.project, `part-${part}.txt`), `${partText(part)}\n`);
    });
  });

  afterAll(async () => {
    await live?.close();
  });

  it("writes a valid handoff at the smallest limit and continues in a successor, waking the caller once", async () => {
    const firstId = await live.run(
      "implementer-tight",
      `Read the files part-1.txt to part-${PARTS}.txt in your current working directory in order, with one read call per file and one file per turn. After reading all of them, reply with the last line of part-${PARTS}.txt.`,
    );

    await live.waitForWakes(1, 3 * LIVE_TIMEOUT_MS);
    await pause(2_000);

    const first = live.registry.get(firstId);
    const chain = first ? chainOf(live, first) : [];
    const last = chain[chain.length - 1];
    const handoff = readFileSync(first?.handoffPath ?? "", "utf8");

    expect(first?.state).toBe("handoff");
    expect(handoffService.validate(handoff)).toEqual({ ok: true, status: "partial" });
    expect(chain.length).toBeGreaterThan(1);
    expect(["done", "handoff"]).toContain(last.state);
    expect(hiddenMessageTexts(live.host)).toHaveLength(1);
    expect(hiddenMessageTexts(live.host)[0]).toContain(last.id);
  });
});
