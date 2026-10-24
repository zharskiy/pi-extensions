import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../../pi-adapter/index.ts";
import { plainTheme, tokenTaggingTheme } from "../../../../test-framework/index.ts";
import type { AgentRecord } from "../../core/model/types.ts";
import { modelLabel, type RowInput, renderRows } from "../../ui/components/agent-row.ts";
import { agentRecord } from "../support/agent-records.ts";

const NOW = 1_000_200;

const MODEL = "prov/model-a:low";

const record = (patch: Partial<AgentRecord> & { elapsed?: number }): AgentRecord => {
  const { elapsed = 0, ...rest } = patch;

  return agentRecord({ id: "a", model: MODEL, startedAt: NOW - elapsed, turns: 1, ...rest });
};

const closed = (patch: Partial<AgentRecord> & { elapsed: number }) =>
  record({ ...patch, startedAt: 0, endedAt: patch.elapsed });

const row = (entry: AgentRecord, patch: Partial<RowInput> = {}): RowInput => ({
  record: entry,
  depth: 0,
  first: true,
  openDescendants: 0,
  ...patch,
});

const scout = record({
  agent: "scout",
  description: "Map the auth module",
  elapsed: 65_000,
  toolCalls: 4,
  tokens: 12_300,
});

const queued = record({ agent: "worker", description: "Rename parseDate callers", state: "queued" });

const doneScout = closed({
  agent: "scout",
  description: "Map the auth module",
  state: "done",
  elapsed: 65_000,
  toolCalls: 4,
  tokens: 12_300,
  cost: 0.04,
});

const SAMPLE: RowInput[] = [
  row(scout),
  row(
    record({
      agent: "reviewer",
      description: "Review the diff of PR 5",
      elapsed: 45_000,
      toolCalls: 2,
      tokens: 8_200,
    }),
    { selected: true, openDescendants: 1 },
  ),
  row(
    record({
      agent: "scout",
      description: "Find callers of login",
      elapsed: 12_000,
      toolCalls: 3,
      tokens: 1_100,
    }),
    { depth: 1 },
  ),
  row(queued),
  row(record({ agent: "worker", description: "Fix the login redirect", state: "grace", elapsed: 123_000 })),
  row(doneScout),
  row(
    closed({
      agent: "worker",
      description: "Fix the login redirect",
      state: "failed",
      elapsed: 130_000,
      toolCalls: 31,
      tokens: 52_400,
      error: "tests failed twice",
    }),
  ),
  row(closed({ agent: "worker", description: "Fix the login redirect", state: "stopped", elapsed: 3_000 })),
  row(
    closed({
      agent: "planner",
      chainIndex: 3,
      description: "Plan the auth rewrite",
      state: "handoff",
      elapsed: 3_720_000,
      toolCalls: 88,
    }),
  ),
];

const rendered = (rows: RowInput[], width: number, theme: ThemeLike = plainTheme) =>
  renderRows(rows, NOW, width, theme);

describe("agent rows", () => {
  it("draws the 80-column sample with aligned columns and the model dropped", () => {
    expect(rendered(SAMPLE, 80)).toEqual([
      "   ⠹ scout          Map the auth module   Elapsed 1m 5s · 4 calls · 12.3k tokens",
      " › ⠹ reviewer (+1)  Review the diff o...  Elapsed 45s · 2 calls · 8.2k tokens",
      "   ↳ ⠹ scout        Find callers of l...  Elapsed 12s · 3 calls · 1.1k tokens",
      "   ◌ worker         Rename parseDate ...  Queued",
      "   ◌ worker         Fix the login red...  Stopping · Elapsed 2m 3s",
      "   ✓ scout          Map the auth module   1m 5s · 4 calls · 12.3k tokens · $0.04",
      "   ✗ worker         Fix the login red...  2m 10s · 31 calls · 52.4k tokens",
      "   ⊘ worker         Fix the login red...  Stopped · 3s · 0 calls",
      "   ⊘ planner #3     Plan the auth rew...  Handed off · 1h 2m · 88 calls",
    ]);
  });

  it("shows the model without its provider and the activity on a wide terminal", () => {
    const busy = { ...scout, cost: 0.04, activity: "grep TODO" };
    const reviewer = closed({
      agent: "reviewer",
      description: "Review the diff of PR 5",
      model: "prov/model-b:high",
      state: "done",
      elapsed: 45_000,
      toolCalls: 2,
      tokens: 8_200,
      cost: 0.03,
    });

    expect(rendered([row(busy), row(reviewer)], 120)).toEqual([
      "   ⠹ scout     Map the auth module      model-a:low   Elapsed 1m 5s · 4 calls · 12.3k tokens · $0.04 · grep TODO",
      "   ✓ reviewer  Review the diff of PR 5  model-b:high  45s · 2 calls · 8.2k tokens · $0.03",
    ]);
  });

  it("cuts the description to 12 and keeps the time and the word at 40 columns", () => {
    expect(rendered([row(scout), row(queued), row(doneScout)], 40)).toEqual([
      "   ⠹ scout   Map the a...  Elapsed 1m 5s",
      "   ◌ worker  Rename pa...  Queued",
      "   ✓ scout   Map the a...  1m 5s",
    ]);
  });

  it("puts a child's mark in its parent's glyph column and indents later siblings and deeper levels", () => {
    const parent = row(scout, { openDescendants: 3 });
    const child = (depth: number, first: boolean) => row({ ...scout, agent: "kid" }, { depth, first });

    expect(rendered([parent, child(1, true), child(2, true), child(1, false)], 80)).toEqual([
      "   ⠹ scout (+3)  Map the auth module  Elapsed 1m 5s · 4 calls · 12.3k tokens",
      "   ↳ ⠹ kid       Map the auth module  Elapsed 1m 5s · 4 calls · 12.3k tokens",
      "     ↳ ⠹ kid     Map the auth module  Elapsed 1m 5s · 4 calls · 12.3k tokens",
      "     ⠹ kid       Map the auth module  Elapsed 1m 5s · 4 calls · 12.3k tokens",
    ]);
  });

  it("advances pi's spinner with the clock and uses the static mark off live surfaces", () => {
    expect(renderRows([row(scout)], 0, 80, plainTheme)[0]).toMatch(/^ {3}⠋ scout/);
    expect(renderRows([row(scout)], NOW, 80, plainTheme, { spinner: false })[0]).toMatch(/^ {3}◌ scout/);
    expect(renderRows([row(scout)], NOW, 80, plainTheme, { bare: true })[0]).toMatch(/^⠹ scout {2}Map/);
  });

  it("paints the pointer, names, suffixes, description, model and status by role", () => {
    const tagged: ThemeLike = {
      ...tokenTaggingTheme({ close: (token) => `</${token}>` }),
      bold: (text) => `<b>${text}</b>`,
    };
    const [open, finished] = renderRows(
      [row(scout, { selected: true, openDescendants: 1 }), row({ ...doneScout, chainIndex: 2 })],
      NOW,
      400,
      tagged,
    );

    expect(open).toBe(
      " <accent><b>›</b></accent> <accent>⠹</accent> <text>scout</text><dim> (+1)</dim>  <muted>Map the auth module</muted>  <dim>model-a:low</dim>  <muted>Elapsed 1m 5s</muted><muted> · </muted><muted>4 calls</muted><muted> · </muted><muted>12.3k tokens</muted>",
    );
    expect(finished).toContain("<success>✓</success> <muted>scout</muted><dim> #2</dim>");
  });

  it("keeps every line within the width", () => {
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 20, 40, 80].forEach((width) => {
      rendered(SAMPLE, width).forEach((line) => {
        expect(plainTheme.width(line)).toBeLessThanOrEqual(width);
      });
    });
  });

  it("cuts a long model in the middle and keeps its thinking suffix", () => {
    expect(modelLabel(plainTheme, "a-very-long-model-name:high", 20)).toBe("a-very-long-...:high");
    expect(modelLabel(plainTheme, "short:low", 20)).toBe("short:low");
  });
});
