import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import { type RowInput, type RowLayout, renderRow, rowLayout } from "../../src/components/agent-row.ts";
import type { AgentRecord } from "../../src/model/types.ts";
import { agentRecord } from "../helpers/records.ts";

const AUTH = { id: "explorer-1a2b", description: "Map the auth module" };

const row = (record: AgentRecord, patch: Partial<RowInput> = {}): RowInput => ({
  record,
  depth: 0,
  last: true,
  ancestorsContinue: [],
  openDescendants: 0,
  selected: false,
  ...patch,
});

type Case = {
  name: string;
  input: RowInput;
  now: number;
  layout?: RowLayout;
  width: number;
  expected: string;
};

const layoutOf = ({ input, now, width, layout }: Case) =>
  layout ?? rowLayout([input], now, width, plainTheme);

const grepping = agentRecord({ ...AUTH, tokens: 12_300, activity: "grep" });
const queued = agentRecord({
  ...AUTH,
  agent: "worker",
  description: "Rename parseDate callers",
  state: "queued",
});
const done = agentRecord({ ...AUTH, state: "done", endedAt: 65_000 });
const failed = agentRecord({
  ...AUTH,
  agent: "worker",
  description: "Fix the login redirect",
  state: "failed",
  endedAt: 130_000,
});
const grace = agentRecord({
  ...AUTH,
  agent: "worker",
  description: "Fix the login redirect",
  state: "grace",
});
const stopped = agentRecord({
  ...AUTH,
  agent: "worker",
  description: "Fix the login redirect",
  state: "stopped",
  endedAt: 3_000,
});
const handedOff = agentRecord({ ...AUTH, state: "handoff", endedAt: 3_720_000 });
const chained = agentRecord({ ...AUTH, chainIndex: 2, tokens: 30_100, activity: "bash" });
const child = agentRecord({
  ...AUTH,
  description: "Find callers of login",
  tokens: 1_100,
  activity: "read",
});
const reviewer = agentRecord({
  ...AUTH,
  agent: "reviewer",
  description: "Review the diff of PR 5",
  tokens: 8_200,
  activity: "writing",
});

const cases: Case[] = [
  {
    name: "renders a running row with activity, elapsed and tokens at 80 columns",
    input: row(grepping),
    now: 65_000,
    width: 80,
    expected: "   ⠋ explorer  Map the auth module  grep · 1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "cuts the description before dropping stats",
    input: row(grepping),
    now: 65_000,
    width: 62,
    expected: "   ⠋ explorer  Map the auth …  grep · 1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "drops the activity, then the tokens, when the description would fall below 12 columns",
    input: row(grepping),
    now: 65_000,
    width: 40,
    expected: "   ⠋ explorer  Map the aut…  1m 5s",
  },
  {
    name: "drops the elapsed too and keeps the description",
    input: row(grepping),
    now: 65_000,
    width: 32,
    expected: "   ⠋ explorer  Map the auth mo…",
  },
  {
    name: "drops the activity when it does not fit after the info column",
    input: row(grepping),
    now: 65_000,
    layout: { nameCols: 9, infoAt: 33 },
    width: 59,
    expected: "   ⠋ explorer   Map the auth modu…  1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "shows queued as the status word",
    input: row(queued),
    now: 65_000,
    width: 80,
    expected: "   ○ worker  Rename parseDate callers  queued",
  },
  {
    name: "keeps the status word on a narrow row",
    input: row(queued),
    now: 65_000,
    width: 32,
    expected: "   ○ worker  Rename pa…  queued",
  },
  {
    name: "shows done with the duration",
    input: row(done),
    now: 99_000,
    width: 80,
    expected: "   ✓ explorer  Map the auth module  done · 1m 5s",
  },
  {
    name: "drops the duration of a closed row and keeps its status word",
    input: row(done),
    now: 99_000,
    width: 32,
    expected: "   ✓ explorer  Map the a…  done",
  },
  {
    name: "omits the description and pads the name when fewer than 8 columns remain",
    input: row(done),
    now: 99_000,
    width: 28,
    expected: "   ✓ explorer          done",
  },
  {
    name: "marks the selected row with the pointer",
    input: row(failed, { selected: true }),
    now: 200_000,
    width: 80,
    expected: " › ✗ worker  Fix the login redirect  failed · 2m 10s",
  },
  {
    name: "shows stopping during grace",
    input: row(grace),
    now: 130_000,
    width: 80,
    expected: "   ◐ worker  Fix the login redirect  stopping",
  },
  {
    name: "shows stopped with the duration",
    input: row(stopped),
    now: 9_000,
    width: 80,
    expected: "   ■ worker  Fix the login redirect  stopped · 3s",
  },
  {
    name: "shows handed off with the duration",
    input: row(handedOff),
    now: 9_000_000,
    width: 80,
    expected: "   ↪ explorer  Map the auth module  handed off · 1h 2m",
  },
  {
    name: "appends the chain index to the name",
    input: row(chained),
    now: 130_000,
    width: 80,
    expected: "   ⠋ explorer #2  Map the auth module  bash · 2m 10s · ↓ 30.1k tokens",
  },
  {
    name: "draws the connector of a last child",
    input: row(child, { depth: 1, last: true }),
    now: 12_000,
    layout: { nameCols: 13, infoAt: 46 },
    width: 80,
    expected: "   └─ ⠋ explorer       Find callers of login     read · 12s · ↓ 1.1k tokens",
  },
  {
    name: "draws continuation bars for deeper rows",
    input: row(child, { depth: 2, last: false, ancestorsContinue: [true] }),
    now: 12_000,
    layout: { nameCols: 13, infoAt: 46 },
    width: 80,
    expected: "   │  ├─ ⠋ explorer       Find callers of login  read · 12s · ↓ 1.1k tokens",
  },
  {
    name: "keeps only the name on a deep row too narrow for any stats",
    input: row(child, { depth: 2, last: false, ancestorsContinue: [true] }),
    now: 12_000,
    layout: { nameCols: 13, infoAt: 46 },
    width: 26,
    expected: "   │  ├─ ⠋ explorer      ",
  },
  {
    name: "shows open descendants and writing",
    input: row(reviewer, { openDescendants: 1, selected: true }),
    now: 45_000,
    width: 80,
    expected: " › ⠋ reviewer (+1)  Review the diff of PR 5  writing · 45s · ↓ 8.2k tokens",
  },
  {
    name: "omits zero tokens",
    input: row(agentRecord(AUTH)),
    now: 3_000,
    width: 80,
    expected: "   ⠋ explorer  Map the auth module  3s",
  },
];

const infoStart = (line: string, cell: string) => plainTheme.width(line.slice(0, line.indexOf(cell)));

describe("agent row", () => {
  it.each(cases)("$name", (testCase) => {
    const { input, now, width, expected } = testCase;
    const line = renderRow(input, now, width, plainTheme, layoutOf(testCase));

    expect(line).toBe(expected);
    expect(line).toMatch(input.selected ? /^ › / : /^ {3}/);
    expect(plainTheme.width(line)).toBeLessThanOrEqual(width - 1);
  });

  it("advances the spinner of a running row with the clock", () => {
    const frames = [0, 250, 950, 1_000].map(
      (now) =>
        renderRow(
          row(agentRecord(AUTH)),
          now,
          80,
          plainTheme,
          rowLayout([row(agentRecord(AUTH))], now, 80, plainTheme),
        )[3],
    );

    expect(frames).toEqual(["⠋", "⠹", "⠏", "⠋"]);
  });

  it("ends every line before the last column", () => {
    cases.forEach((testCase) => {
      [80, 60, 40, 30, 20].forEach((width) => {
        const line = renderRow(testCase.input, testCase.now, width, plainTheme, layoutOf(testCase));

        expect(plainTheme.width(line)).toBeLessThanOrEqual(width - 1);
        expect(line).toMatch(testCase.input.selected ? /^ › / : /^ {3}/);
      });
    });
  });

  it("starts the info two columns after the longest description of the surface", () => {
    const rows = [row(grepping), row(queued), row(done)];
    const layout = rowLayout(rows, 99_000, 200, plainTheme);
    const lines = rows.map((input) => renderRow(input, 99_000, 200, plainTheme, layout));

    expect(layout).toEqual({ nameCols: 8, infoAt: 14 + 24 });
    expect(infoStart(lines[0], "grep")).toBe(1 + layout.infoAt + 2);
    expect(infoStart(lines[1], "queued")).toBe(1 + layout.infoAt + 2);
    expect(infoStart(lines[2], "done")).toBe(1 + layout.infoAt + 2);
    expect(lines[0]).toBe("   ⠋ explorer  Map the auth module       grep · 1m 39s · ↓ 12.3k tokens");
    expect(lines[2]).toBe("   ✓ explorer  Map the auth module       done · 1m 5s");
  });

  it("caps the description column at 48 and cuts longer descriptions", () => {
    const long = row(agentRecord({ ...AUTH, state: "done", endedAt: 65_000, description: "d".repeat(60) }));
    const layout = rowLayout([long], 99_000, 200, plainTheme);
    const line = renderRow(long, 99_000, 200, plainTheme, layout);

    expect(layout.infoAt).toBe(14 + 48);
    expect(line).toBe(`   ✓ explorer  ${"d".repeat(47)}…  done · 1m 5s`);
  });

  it("moves the info column left to keep 30 columns for running stats on a narrow terminal", () => {
    const rows = [row(grepping), row(done)];
    const layout = rowLayout(rows, 65_000, 62, plainTheme);
    const lines = rows.map((input) => renderRow(input, 65_000, 62, plainTheme, layout));

    expect(layout.infoAt).toBe(60 - 2 - 30);
    expect(infoStart(lines[0], "grep")).toBe(infoStart(lines[1], "done"));
    expect(lines).toEqual([
      "   ⠋ explorer  Map the auth …  grep · 1m 5s · ↓ 12.3k tokens",
      "   ✓ explorer  Map the auth …  done · 1m 5s",
    ]);
  });

  it("keeps the info column still while the activity and elapsed change", () => {
    const at = (activity: string, tokens: number) =>
      row(agentRecord({ ...AUTH, tokens, activity: activity, description: "d".repeat(60) }));
    const first = [at("ls", 1_000), row(child, { depth: 1 })];
    const second = [at("tool_search", 123_500), row(child, { depth: 1 })];

    [70, 100, 140].forEach((width) => {
      const before = rowLayout(first, 5_000, width, plainTheme);
      const after = rowLayout(second, 605_000, width, plainTheme);
      const line = renderRow(second[0], 605_000, width, plainTheme, after);

      expect(after.infoAt).toBe(before.infoAt);
      expect(plainTheme.width(line)).toBeLessThanOrEqual(width - 1);
    });
  });

  it("keeps a readable description on a deep row next to a root with long stats", () => {
    const root = row(agentRecord({ ...AUTH, tokens: 123_500, activity: "tool_search" }), {
      openDescendants: 1,
    });
    const deep = row(agentRecord({ ...AUTH, tokens: 10, activity: "ls" }), {
      depth: 4,
      ancestorsContinue: [true, true, true],
    });
    const layout = rowLayout([root, deep], 5_000, 70, plainTheme);
    const lines = [root, deep].map((input) => renderRow(input, 5_000, 70, plainTheme, layout));

    expect(lines).toEqual([
      "   ⠋ explorer (+1)  Map the auth module       5s · ↓ 123.5k tokens",
      "   │  │  │  └─ ⠋ explorer       Map the aut…  ls · 5s · ↓ 10 tokens",
    ]);
    expect(infoStart(lines[0], "5s")).toBe(infoStart(lines[1], "ls"));
  });

  it("keeps the stats of a row with a short description", () => {
    const short = row(agentRecord({ ...AUTH, description: "ab", tokens: 12_300, activity: "grep" }));
    const line = renderRow(short, 65_000, 80, plainTheme, rowLayout([short], 65_000, 80, plainTheme));

    expect(line).toBe("   ⠋ explorer  ab  grep · 1m 5s · ↓ 12.3k tokens");
  });

  it("reserves the pointer columns on every row, selected or not", () => {
    const rows = [row(grepping), row(failed)];
    const layout = rowLayout(rows, 200_000, 120, plainTheme);
    const pointed = renderRow({ ...rows[1], selected: true }, 200_000, 120, plainTheme, layout);
    const idle = renderRow(rows[1], 200_000, 120, plainTheme, layout);
    const other = renderRow(rows[0], 200_000, 120, plainTheme, layout);

    expect(infoStart(pointed, "failed")).toBe(infoStart(other, "grep"));
    expect(infoStart(idle, "failed")).toBe(infoStart(other, "grep"));
    expect(pointed.slice(3)).toBe(idle.slice(3));
  });

  it("puts the pointer after the pad without moving the selected row", () => {
    [80, 40, 20].forEach((width) => {
      const layout = rowLayout([row(failed)], 200_000, width, plainTheme);
      const plainLine = renderRow(row(failed), 200_000, width, plainTheme, layout);
      const pointed = renderRow(row(failed, { selected: true }), 200_000, width, plainTheme, layout);

      expect(plainLine.indexOf("✗")).toBe(3);
      expect(plainLine.startsWith("   ")).toBe(true);
      expect(pointed.indexOf("✗")).toBe(3);
      expect(pointed.startsWith(" › ")).toBe(true);
      expect(plainTheme.width(plainLine)).toBeLessThanOrEqual(width - 1);
      expect(plainTheme.width(pointed)).toBeLessThanOrEqual(width - 1);
    });
  });

  it("paints the parts with the theme tokens", () => {
    const recording: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}` };
    const line = renderRow(
      row(failed, { selected: true }),
      200_000,
      80,
      recording,
      rowLayout([row(failed)], 200_000, 80, plainTheme),
    );

    expect(line).toContain("<accent>›");
    expect(line).toContain("<error>✗");
    expect(line).toContain("<muted>worker");
    expect(line).toContain("<error>failed");
    expect(line).toContain("<dim>2m 10s");
  });

  it("measures the name column over names, chain suffixes and counts, capped at 24", () => {
    const first = row(agentRecord(AUTH));
    const second = row(agentRecord({ ...AUTH, chainIndex: 2 }), { openDescendants: 3 });
    const third = row(agentRecord({ ...AUTH, agent: "a".repeat(40) }));
    const nameCols = (rows: RowInput[]) => rowLayout(rows, 0, 80, plainTheme).nameCols;

    expect(nameCols([])).toBe(0);
    expect(nameCols([first])).toBe(8);
    expect(nameCols([first, second])).toBe(16);
    expect(nameCols([first, second, third])).toBe(24);
  });

  it("collapses whitespace in the description", () => {
    const input = row(agentRecord({ ...AUTH, description: "a\n  b" }));

    expect(
      renderRow(input, 3_000, 80, plainTheme, rowLayout([input], 3_000, 80, plainTheme)),
    ).toContain("a b");
  });
});
