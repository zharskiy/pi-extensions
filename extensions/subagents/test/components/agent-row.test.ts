import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import {
  DESCRIPTION_COLS_MAX,
  POINTER_COLS,
  type RowInput,
  type RowLayout,
  renderRow,
  rowLayout,
} from "../../src/components/agent-row.ts";
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

type Case = {
  name: string;
  input: RowInput;
  now: number;
  layout?: RowLayout;
  width: number;
  expected: string;
};

const layoutOf = ({ input, now, width, layout }: Case) =>
  layout ?? rowLayout([input], now, width, input.selected);

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
    width: 80,
    expected: " ⠋ explorer  Map the auth module  grep · 1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "cuts the description before dropping stats",
    input: row(grepping),
    now: 65_000,
    width: 60,
    expected: " ⠋ explorer  Map the auth m…  grep · 1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "drops the activity, then the tokens, when the description would fall below 12 columns",
    input: row(grepping),
    now: 65_000,
    width: 38,
    expected: " ⠋ explorer  Map the auth mod…  1m 5s",
  },
  {
    name: "drops the elapsed too and keeps the description",
    input: row(grepping),
    now: 65_000,
    width: 30,
    expected: " ⠋ explorer  Map the auth mo…",
  },
  {
    name: "drops the activity when the description room would be 10 columns",
    input: row(grepping),
    now: 65_000,
    layout: { nameCols: 9, infoAt: 31 },
    width: 56,
    expected: " ⠋ explorer   Map the auth mod…  1m 5s · ↓ 12.3k tokens",
  },
  {
    name: "shows queued as the status word",
    input: row(queued),
    now: 65_000,
    width: 80,
    expected: " ○ worker  Rename parseDate callers  queued",
  },
  {
    name: "keeps the status word on a narrow row",
    input: row(queued),
    now: 65_000,
    width: 30,
    expected: " ○ worker  Rename pa…  queued",
  },
  {
    name: "shows done with the duration",
    input: row(done),
    now: 99_000,
    width: 80,
    expected: " ✓ explorer  Map the auth module  done · 1m 5s",
  },
  {
    name: "drops the duration of a closed row and keeps its status word",
    input: row(done),
    now: 99_000,
    width: 30,
    expected: " ✓ explorer  Map the a…  done",
  },
  {
    name: "omits the description and pads the name when fewer than 8 columns remain",
    input: row(done),
    now: 99_000,
    width: 26,
    expected: " ✓ explorer          done",
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
    expected: " ◐ worker  Fix the login redirect  stopping",
  },
  {
    name: "appends the chain index to the name",
    input: row(chained),
    now: 130_000,
    width: 80,
    expected: " ⠋ explorer #2  Map the auth module  bash · 2m 10s · ↓ 30.1k tokens",
  },
  {
    name: "draws the connector of a last child",
    input: row(child, { depth: 1, last: true }),
    now: 12_000,
    layout: { nameCols: 13, infoAt: 44 },
    width: 80,
    expected: " └─ ⠋ explorer       Find callers of login     read · 12s · ↓ 1.1k tokens",
  },
  {
    name: "draws continuation bars for deeper rows",
    input: row(child, { depth: 2, last: false, ancestorsContinue: [true] }),
    now: 12_000,
    layout: { nameCols: 13, infoAt: 44 },
    width: 80,
    expected: " │  ├─ ⠋ explorer       Find callers of login  read · 12s · ↓ 1.1k tokens",
  },
  {
    name: "keeps only the name on a deep row too narrow for any stats",
    input: row(child, { depth: 2, last: false, ancestorsContinue: [true] }),
    now: 12_000,
    layout: { nameCols: 13, infoAt: 44 },
    width: 24,
    expected: " │  ├─ ⠋ explorer      ",
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
    input: row(rec()),
    now: 3_000,
    width: 80,
    expected: " ⠋ explorer  Map the auth module  3s",
  },
];

const infoStart = (line: string, cell: string) => displayWidth(line.slice(0, line.indexOf(cell)));

describe("agent row", () => {
  it.each(cases)("$name", (testCase) => {
    const { input, now, width, expected } = testCase;
    const line = renderRow(input, now, width, plainTheme, layoutOf(testCase));

    expect(line).toBe(expected);
    expect(line).toMatch(input.selected ? /^ › / : /^ [^›]/);
    expect(displayWidth(line)).toBeLessThanOrEqual(width - 1);
  });

  it("ends every line before the last column", () => {
    cases.forEach((testCase) => {
      [80, 60, 40, 30, 20].forEach((width) => {
        const line = renderRow(testCase.input, testCase.now, width, plainTheme, layoutOf(testCase));

        expect(displayWidth(line)).toBeLessThanOrEqual(width - 1);
        expect(line).toMatch(testCase.input.selected ? /^ › / : /^ [^›]/);
      });
    });
  });

  it("starts the info two columns after the longest description of the surface", () => {
    const rows = [row(grepping), row(queued), row(done)];
    const layout = rowLayout(rows, 99_000, 200, false);
    const lines = rows.map((input) => renderRow(input, 99_000, 200, plainTheme, layout));

    expect(layout).toEqual({ nameCols: 8, infoAt: 12 + 24 });
    expect(infoStart(lines[0], "grep")).toBe(1 + layout.infoAt + 2);
    expect(infoStart(lines[1], "queued")).toBe(1 + layout.infoAt + 2);
    expect(infoStart(lines[2], "done")).toBe(1 + layout.infoAt + 2);
    expect(lines[0]).toBe(" ⠋ explorer  Map the auth module       grep · 1m 39s · ↓ 12.3k tokens");
    expect(lines[2]).toBe(" ✓ explorer  Map the auth module       done · 1m 5s");
  });

  it("caps the description column at 48 and cuts longer descriptions", () => {
    const long = row(rec({ state: "done", endedAt: 65_000, description: "d".repeat(60) }));
    const layout = rowLayout([long], 99_000, 200, false);
    const line = renderRow(long, 99_000, 200, plainTheme, layout);

    expect(layout.infoAt).toBe(12 + DESCRIPTION_COLS_MAX);
    expect(line).toBe(` ✓ explorer  ${"d".repeat(47)}…  done · 1m 5s`);
  });

  it("moves the info column left so the widest stats end at inner on a narrow terminal", () => {
    const rows = [row(grepping), row(done)];
    const layout = rowLayout(rows, 65_000, 60, false);
    const lines = rows.map((input) => renderRow(input, 65_000, 60, plainTheme, layout));

    expect(layout.infoAt).toBe(58 - 2 - displayWidth("grep · 1m 5s · ↓ 12.3k tokens"));
    expect(infoStart(lines[0], "grep")).toBe(infoStart(lines[1], "done"));
    expect(displayWidth(lines[0])).toBe(59);
    expect(lines).toEqual([
      " ⠋ explorer  Map the auth m…  grep · 1m 5s · ↓ 12.3k tokens",
      " ✓ explorer  Map the auth m…  done · 1m 5s",
    ]);
  });

  it("keeps the stats of a row with a short description", () => {
    const short = row(
      rec({ description: "ab", tokens: 12_300, activity: { kind: "tool", text: "grep", at: 0 } }),
    );
    const line = renderRow(short, 65_000, 80, plainTheme, rowLayout([short], 65_000, 80, false));

    expect(line).toBe(" ⠋ explorer  ab  grep · 1m 5s · ↓ 12.3k tokens");
  });

  it("reserves the pointer columns while a row is selected", () => {
    const rows = [row(grepping), row(failed)];
    const idle = rowLayout(rows, 200_000, 120, false);
    const selecting = rowLayout(rows, 200_000, 120, true);
    const pointed = renderRow({ ...rows[1], selected: true }, 200_000, 120, plainTheme, selecting);
    const other = renderRow(rows[0], 200_000, 120, plainTheme, selecting);

    expect(selecting.infoAt).toBe(idle.infoAt + POINTER_COLS);
    expect(infoStart(pointed, "failed")).toBe(infoStart(other, "grep"));
  });

  it("puts the pointer after the pad and shifts the selected row by two", () => {
    [80, 40, 20].forEach((width) => {
      const plainLine = renderRow(
        row(failed),
        200_000,
        width,
        plainTheme,
        rowLayout([row(failed)], 200_000, width, false),
      );
      const layout = rowLayout([row(failed)], 200_000, width, true);
      const pointed = renderRow(row(failed, { selected: true }), 200_000, width, plainTheme, layout);

      expect(plainLine.indexOf("✗")).toBe(1);
      expect(pointed.indexOf("✗")).toBe(3);
      expect(pointed.startsWith(" › ")).toBe(true);
      expect(displayWidth(plainLine)).toBeLessThanOrEqual(width - 1);
      expect(displayWidth(pointed)).toBeLessThanOrEqual(width - 1);
    });
  });

  it("paints the parts with the theme tokens", () => {
    const recording: ThemeLike = { fg: (token, text) => `<${token}>${text}`, bold: (text) => text };
    const line = renderRow(
      row(failed, { selected: true }),
      200_000,
      80,
      recording,
      rowLayout([row(failed)], 200_000, 80, true),
    );

    expect(line).toContain("<accent>›");
    expect(line).toContain("<error>✗");
    expect(line).toContain("<muted>worker");
    expect(line).toContain("<error>failed");
    expect(line).toContain("<dim>2m 10s");
  });

  it("measures the name column over names, chain suffixes and counts, capped at 24", () => {
    const first = row(rec());
    const second = row(rec({ chainIndex: 2 }), { openDescendants: 3 });
    const third = row(rec({ agent: "a".repeat(40) }));
    const nameCols = (rows: RowInput[]) => rowLayout(rows, 0, 80, false).nameCols;

    expect(nameCols([])).toBe(0);
    expect(nameCols([first])).toBe(8);
    expect(nameCols([first, second])).toBe(16);
    expect(nameCols([first, second, third])).toBe(24);
  });

  it("collapses whitespace in the description", () => {
    const input = row(rec({ description: "a\n  b" }));

    expect(renderRow(input, 3_000, 80, plainTheme, rowLayout([input], 3_000, 80, false))).toContain("a b");
  });
});
