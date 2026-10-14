import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import { nameColumn, type RowInput, renderRow } from "../../src/components/agent-row.ts";
import { displayWidth } from "../../src/components/format.ts";
import type { AgentRecord } from "../../src/model/types.ts";

const rec = (patch: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "explorer-1a2b",
  agent: "explorer",
  description: "Map the auth module",
  callerId: "main",
  depth: 2,
  batchId: "b-1",
  chainIndex: 1,
  state: "running",
  createdAt: 0,
  startedAt: 0,
  turns: 0,
  toolCalls: 0,
  tokens: 0,
  lastText: "",
  handoffPath: "/x/handoff.md",
  dir: "/x",
  contextLimit: 100_000,
  handoffRequested: false,
  version: 0,
  ...patch,
});

const row = (record: AgentRecord, patch: Partial<RowInput> = {}): RowInput => ({
  record,
  depth: 0,
  last: true,
  ancestorsContinue: [],
  openDescendants: 0,
  selected: false,
  ...patch,
});

type Case = { name: string; input: RowInput; now: number; nameCols: number; width: number; expected: string };

const grepping = rec({ tokens: 12_300, activity: { kind: "tool", text: "grep", at: 0 } });
const queued = rec({ agent: "worker", description: "Rename parseDate callers", state: "queued" });
const done = rec({ state: "done", endedAt: 65_000 });
const failed = rec({
  agent: "worker",
  description: "Fix the login redirect",
  state: "failed",
  endedAt: 130_000,
});
const grace = rec({ agent: "worker", description: "Fix the login redirect", state: "grace" });
const chained = rec({ chainIndex: 2, tokens: 30_100, activity: { kind: "tool", text: "bash", at: 0 } });
const child = rec({
  description: "Find callers of login",
  tokens: 1_100,
  activity: { kind: "tool", text: "read", at: 0 },
});
const reviewer = rec({
  agent: "reviewer",
  description: "Review the diff of PR 5",
  tokens: 8_200,
  activity: { kind: "text", text: "Looking at the diff", at: 0 },
});

const cases: Case[] = [
  {
    name: "renders a running row with activity, elapsed and tokens at 80 columns",
    input: row(grepping),
    now: 65_000,
    nameCols: 8,
    width: 80,
    expected: "   ⠋ explorer  Map the auth module                grep · 1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "cuts the description before dropping stats",
    input: row(grepping),
    now: 65_000,
    nameCols: 8,
    width: 60,
    expected: "   ⠋ explorer  Map the auth…  grep · 1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "drops the activity, then the tokens, when the description would fall below 12 columns",
    input: row(grepping),
    now: 65_000,
    nameCols: 8,
    width: 40,
    expected: "   ⠋ explorer  Map the auth mod…  1m 5s",
  },
  {
    name: "drops the elapsed too and keeps the description",
    input: row(grepping),
    now: 65_000,
    nameCols: 8,
    width: 30,
    expected: "   ⠋ explorer  Map the auth…",
  },
  {
    name: "drops the activity when the description room would be 10 columns",
    input: row(grepping),
    now: 65_000,
    nameCols: 9,
    width: 58,
    expected: "   ⠋ explorer   Map the auth mod…  1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "shows queued as the status word",
    input: row(queued),
    now: 65_000,
    nameCols: 6,
    width: 80,
    expected: "   ○ worker  Rename parseDate callers                                    queued",
  },
  {
    name: "keeps the status word on a narrow row",
    input: row(queued),
    now: 65_000,
    nameCols: 6,
    width: 30,
    expected: "   ○ worker  Rename…   queued",
  },
  {
    name: "shows done with the duration",
    input: row(done),
    now: 99_000,
    nameCols: 8,
    width: 80,
    expected: "   ✓ explorer  Map the auth module                                 done · 1m 5s",
  },
  {
    name: "drops the duration of a closed row and keeps its status word",
    input: row(done),
    now: 99_000,
    nameCols: 8,
    width: 30,
    expected: "   ✓ explorer  Map the…  done",
  },
  {
    name: "omits the description and pads the name when fewer than 8 columns remain",
    input: row(done),
    now: 99_000,
    nameCols: 8,
    width: 26,
    expected: "   ✓ explorer        done",
  },
  {
    name: "marks the selected row with the pointer",
    input: row(failed, { selected: true }),
    now: 200_000,
    nameCols: 6,
    width: 80,
    expected: " › ✗ worker  Fix the login redirect                             failed · 2m 10s",
  },
  {
    name: "shows stopping during grace",
    input: row(grace),
    now: 130_000,
    nameCols: 6,
    width: 80,
    expected: "   ◐ worker  Fix the login redirect                                    stopping",
  },
  {
    name: "appends the chain index to the name",
    input: row(chained),
    now: 130_000,
    nameCols: 11,
    width: 80,
    expected: "   ⠋ explorer #2  Map the auth module            bash · 2m 10s · ↓ 30.1k tokens",
  },
  {
    name: "draws the connector of a last child",
    input: row(child, { depth: 1, last: true }),
    now: 12_000,
    nameCols: 13,
    width: 80,
    expected: "   └─ ⠋ explorer       Find callers of login         read · 12s · ↓ 1.1k tokens",
  },
  {
    name: "draws continuation bars for deeper rows",
    input: row(child, { depth: 2, last: false, ancestorsContinue: [true] }),
    now: 12_000,
    nameCols: 13,
    width: 80,
    expected: "   │  ├─ ⠋ explorer       Find callers of login      read · 12s · ↓ 1.1k tokens",
  },
  {
    name: "keeps only the name on a deep row too narrow for any stats",
    input: row(child, { depth: 2, last: false, ancestorsContinue: [true] }),
    now: 12_000,
    nameCols: 13,
    width: 24,
    expected: "   │  ├─ ⠋ explorer    ",
  },
  {
    name: "shows open descendants and writing",
    input: row(reviewer, { openDescendants: 1, selected: true }),
    now: 45_000,
    nameCols: 13,
    width: 80,
    expected: " › ⠋ reviewer (+1)  Review the diff of PR 5       writing · 45s · ↓ 8.2k tokens",
  },
  {
    name: "omits zero tokens",
    input: row(rec()),
    now: 3_000,
    nameCols: 8,
    width: 80,
    expected: "   ⠋ explorer  Map the auth module                                           3s",
  },
];

const hasStats = (line: string) => !line.endsWith("…");

describe("agent row", () => {
  it.each(cases)("$name", ({ input, now, nameCols, width, expected }) => {
    const line = renderRow(input, now, width, plainTheme, nameCols);

    expect(line).toBe(expected);
    expect(line.startsWith(" ")).toBe(true);

    if (hasStats(expected)) {
      expect(displayWidth(line)).toBe(width - 1);
    }
  });

  it("ends every line before the last column", () => {
    cases.forEach(({ input, now, nameCols }) => {
      [80, 60, 40, 30, 20].forEach((width) => {
        const line = renderRow(input, now, width, plainTheme, nameCols);

        expect(displayWidth(line)).toBeLessThanOrEqual(width - 1);
        expect(line.startsWith(" ")).toBe(true);
      });
    });
  });

  it("paints the parts with the theme tokens", () => {
    const recording: ThemeLike = { fg: (token, text) => `<${token}>${text}`, bold: (text) => text };
    const line = renderRow(row(failed, { selected: true }), 200_000, 80, recording, 6);

    expect(line).toContain("<accent>›");
    expect(line).toContain("<error>✗");
    expect(line).toContain("<muted>worker");
    expect(line).toContain("<error>failed");
    expect(line).toContain("<dim>2m 10s");
  });

  it("measures the name column over names, chain suffixes and counts, capped at 24", () => {
    const first = { record: rec(), openDescendants: 0 };
    const second = { record: rec({ chainIndex: 2 }), openDescendants: 3 };
    const third = { record: rec({ agent: "a".repeat(40) }), openDescendants: 0 };

    expect(nameColumn([])).toBe(0);
    expect(nameColumn([first])).toBe(8);
    expect(nameColumn([first, second])).toBe(16);
    expect(nameColumn([first, second, third])).toBe(24);
  });

  it("collapses whitespace in the description", () => {
    expect(renderRow(row(rec({ description: "a\n  b" })), 3_000, 80, plainTheme, 8)).toContain("a b");
  });
});
