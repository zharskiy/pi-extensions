import { describe, expect, it } from "vitest";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import {
  emptyListText,
  groupOf,
  listEntries,
  moveSelection,
  renderList,
  selectedRecord,
} from "../../src/components/agent-list.ts";
import type { AgentRecord } from "../../src/model/types.ts";

const record = (id: string, patch: Partial<AgentRecord> = {}): AgentRecord => ({
  id,
  agent: id.split("-")[0] ?? id,
  task: "t",
  description: `work of ${id}`,
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
  budgetTokens: 100_000,
  handoffRequested: false,
  version: 0,
  ...patch,
});

const records = [
  record("explorer-old", { createdAt: 1 }),
  record("explorer-new", { createdAt: 5 }),
  record("reviewer-q", { state: "queued", createdAt: 3 }),
  record("explorer-grace", { state: "grace", createdAt: 2 }),
  record("reviewer-ask", { attention: { kind: "confirm", title: "Allow?", since: 0 }, createdAt: 4 }),
  record("explorer-done", { state: "done", createdAt: 6, endedAt: 7 }),
  record("reviewer-failed", { state: "failed", createdAt: 7, endedAt: 8 }),
  record("explorer-stopped", { state: "stopped", createdAt: 8, endedAt: 9 }),
  record("explorer-handoff", { state: "handoff", createdAt: 9, endedAt: 10 }),
];

const summary = (entries: ReturnType<typeof listEntries>) =>
  entries.map((entry) => (entry.kind === "header" ? `# ${entry.group}` : entry.record.id));

describe("agent list model", () => {
  it("groups by state with the newest agent first inside each group", () => {
    expect(summary(listEntries(records, ""))).toEqual([
      "# working",
      "explorer-new",
      "reviewer-q",
      "explorer-old",
      "# attention",
      "reviewer-ask",
      "explorer-grace",
      "# done",
      "explorer-done",
      "# failed",
      "reviewer-failed",
      "# closed",
      "explorer-handoff",
      "explorer-stopped",
    ]);
  });

  it("puts open agents waiting for input under needs attention, never closed ones", () => {
    const attention = { kind: "input" as const, title: "Name?", since: 0 };

    expect(groupOf(record("a-1", { state: "queued", attention }))).toBe("attention");
    expect(groupOf(record("a-2", { state: "done", attention }))).toBe("done");
  });

  it("moves the selection over agents only and clamps at both ends", () => {
    const entries = listEntries(records, "");

    expect(selectedRecord(entries, undefined)?.id).toBe("explorer-new");
    expect(moveSelection(entries, undefined, -1)).toBe("explorer-new");
    expect(moveSelection(entries, "explorer-old", 1)).toBe("reviewer-ask");
    expect(moveSelection(entries, "reviewer-ask", -1)).toBe("explorer-old");
    expect(moveSelection(entries, "explorer-stopped", 1)).toBe("explorer-stopped");
  });

  it("filters by agent name, id, state or group", () => {
    expect(summary(listEntries(records, "REVIEWER"))).toEqual([
      "# working",
      "reviewer-q",
      "# attention",
      "reviewer-ask",
      "# failed",
      "reviewer-failed",
    ]);
    expect(summary(listEntries(records, "queued"))).toEqual(["# working", "reviewer-q"]);
    expect(summary(listEntries(records, "attention"))).toEqual([
      "# attention",
      "reviewer-ask",
      "explorer-grace",
    ]);
    expect(summary(listEntries(records, "grace"))).toEqual(["# attention", "explorer-grace"]);
    expect(selectedRecord(listEntries(records, "failed"), "explorer-new")?.id).toBe("reviewer-failed");
  });

  it("explains an empty list", () => {
    expect(emptyListText(0, "")).toBe("no agents in this session yet");
    expect(emptyListText(3, " zz ")).toBe('no agents match "zz"');
  });

  it("renders group headers, marks the selected row and indents nested agents", () => {
    const nested = [
      record("explorer-a", { createdAt: 2 }),
      record("explorer-b", { createdAt: 1, depth: 3, chainIndex: 2 }),
      record("explorer-c", { state: "done", createdAt: 3, endedAt: 3 }),
    ];
    const rendered = renderList(listEntries(nested, ""), "explorer-b", 0, 0, plainTheme, 120);

    expect(rendered.lines).toEqual([
      "Working · 2",
      "  ⠋ explorer-a · work of explorer-a · 0 tool calls · 0 tokens · 0s",
      "›   ⠋ explorer-b #2 · work of explorer-b · 0 tool calls · 0 tokens · 0s",
      "",
      "Done · 1",
      "  ✓ explorer-c · work of explorer-c · Done (0 tool calls · 0 tokens · 0s)",
    ]);
    expect(rendered.selectedRow).toBe(2);
  });
});
