import { describe, expect, it } from "vitest";
import type { ThemeLike } from "../../../../core/adapter/contract.ts";
import { plainTheme } from "../../../../core/test/helpers/fakes.ts";
import {
  agentReceipt,
  alignRight,
  cutChars,
  firstLine,
  formatCalls,
  formatCtx,
  receipt,
  receiptText,
  singleLine,
  truncatePainted,
  wrapCols,
} from "../../src/components/format.ts";
import type { AgentRecord } from "../../src/model/types.ts";
import { agentRecord } from "../helpers/records.ts";

const tagged: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}</>` };

const worked = { startedAt: 0, toolCalls: 4, tokens: 12_300, cost: 0.04, turns: 2 };

const shown = (patch: Partial<AgentRecord>, live = true, reason?: string, room = 200) =>
  receiptText(agentReceipt(agentRecord({ id: "a", ...patch }), 65_000, { live, reason }), room, plainTheme);

describe("format helpers", () => {
  it("collapses whitespace and picks the first non-empty line", () => {
    expect(singleLine(" a \n b ")).toBe("a b");
    expect(firstLine("\n\n  x\ny")).toBe("x");
    expect(firstLine("")).toBe("");
  });

  it("cuts by characters with a trailing ellipsis", () => {
    expect(cutChars("Map the auth module", 8)).toBe("Map t...");
    expect(cutChars("short", 10)).toBe("short");
    expect(cutChars("x", 0)).toBe("...");
  });

  it("aligns right inside the given columns", () => {
    expect(alignRight(plainTheme, "hint", "1-9/9", 20)).toBe("hint           1-9/9");
    expect(plainTheme.width(alignRight(plainTheme, "hint", "1-9/9", 20) ?? "")).toBe(20);
    expect(alignRight(plainTheme, "日本", "x", 8)).toBe("日本   x");
  });

  it("returns undefined when both parts do not fit", () => {
    expect(alignRight(plainTheme, "abcdefgh", "1-9/9", 14)).toBeUndefined();
    expect(plainTheme.width(alignRight(plainTheme, "abcdefg", "1-9/9", 14) ?? "")).toBe(14);
  });

  it("cuts painted parts as one line and paints only what remains", () => {
    const parts = [
      ["Agents", (text: string) => `<b>${text}</b>`],
      [" · 3 running", (text: string) => `<dim>${text}</dim>`],
    ] as const;

    expect(truncatePainted(plainTheme, parts, 40)).toBe("<b>Agents</b><dim> · 3 running</dim>");
    expect(truncatePainted(plainTheme, parts, 10)).toBe("<b>Agents</b><dim> ...</dim>");
    expect(truncatePainted(plainTheme, parts, 4)).toBe("<b>A...</b>");
  });

  it("wraps at the column budget with at least one character per piece and whole wide characters", () => {
    expect(wrapCols(plainTheme, "abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(wrapCols(plainTheme, "", 3)).toEqual([""]);
    expect(wrapCols(plainTheme, "日本語", 1)).toEqual(["日", "本", "語"]);

    const pieces = wrapCols(plainTheme, "漢字".repeat(60), 39);

    expect(pieces.every((piece) => plainTheme.width(piece) <= 38)).toBe(true);
    expect(pieces.join("")).toBe("漢字".repeat(60));
  });

  it("shows the context share as a word", () => {
    expect(formatCtx(31.4)).toBe("31% context");
    expect(formatCtx(null)).toBeUndefined();
  });

  it("composes one receipt per agent state", () => {
    expect(shown({ ...worked, activity: "grep TODO" })).toBe(
      "Elapsed 1m 5s · 4 calls · 12.3k tokens · $0.04 · grep TODO",
    );
    expect(shown({ ...worked }, false)).toBe("Running");
    expect(shown({ state: "running" })).toBe("Starting");
    expect(shown({ state: "queued" })).toBe("Queued");
    expect(shown({ state: "grace", startedAt: 0 })).toBe("Stopping · Elapsed 1m 5s");
    expect(shown({ ...worked, state: "done", endedAt: 65_000 })).toBe(
      "1m 5s · 4 calls · 12.3k tokens · $0.04",
    );
    expect(shown({ ...worked, state: "done", cost: 0.001, endedAt: 65_000 })).toContain("· <$0.01");
    expect(shown({ ...worked, state: "failed", endedAt: 65_000 }, true, "tests failed twice")).toBe(
      "tests failed twice · 1m 5s · 4 calls · 12.3k tokens · $0.04",
    );
    expect(shown({ state: "stopped", endedAt: 3_000 })).toBe("Stopped · 3s · 0 calls");
    expect(shown({ ...worked, state: "handoff", endedAt: 3_720_000 })).toBe(
      "Handed off · 1h 2m · 4 calls · 12.3k tokens · $0.04",
    );
  });

  it("drops activity, cost, calls and tokens before the time or the word", () => {
    expect(shown({ ...worked, activity: "grep" }, true, undefined, 20)).toBe("Elapsed 1m 5s");
    expect(shown({ ...worked, state: "handoff", endedAt: 3_720_000 }, true, undefined, 5)).toBe(
      "Handed off · 1h 2m",
    );
  });
});

describe("calls", () => {
  it("counts calls in the singular and plural", () => {
    expect([0, 1, 4].map(formatCalls)).toEqual(["0 calls", "1 call", "4 calls"]);
  });
});

describe("receipt", () => {
  const facts = { elapsedMs: 65_000, calls: 4, tokens: 12_300, cost: 0.04, activity: "grep TODO" };
  const plain = (segments: ReturnType<typeof receipt>, room = 200) => receiptText(segments, room, plainTheme);

  it("writes Elapsed only while running and puts the activity last", () => {
    expect(plain(receipt({ ...facts, running: true }))).toBe(
      "Elapsed 1m 5s · 4 calls · 12.3k tokens · $0.04 · grep TODO",
    );
    expect(plain(receipt({ ...facts, activity: undefined, running: false }))).toBe(
      "1m 5s · 4 calls · 12.3k tokens · $0.04",
    );
  });

  it("puts the state word or the failure reason first", () => {
    expect(plain(receipt({ word: "Stopped", elapsedMs: 3_000, calls: 0, running: false }))).toBe(
      "Stopped · 3s · 0 calls",
    );
    expect(plain(receipt({ word: "Stopping", elapsedMs: 123_000, running: true }))).toBe(
      "Stopping · Elapsed 2m 3s",
    );
    expect(plain(receipt({ word: "Queued", running: false }))).toBe("Queued");
    expect(
      plain(receipt({ reason: "tests failed twice", elapsedMs: 130_000, calls: 31, running: false })),
    ).toBe("tests failed twice · 2m 10s · 31 calls");
  });

  it("omits segments without data, except 0 calls on a stopped agent", () => {
    expect(plain(receipt({ elapsedMs: 1_000, calls: 0, tokens: 0, cost: 0, running: false }))).toBe("1s");
  });

  it("drops the activity, then the cost, then the calls, then the tokens, never the word or the time", () => {
    const segments = receipt({ ...facts, word: "Stopping", running: true });
    const full = "Stopping · Elapsed 1m 5s · 4 calls · 12.3k tokens · $0.04 · grep TODO";

    expect([80, 60, 50, 40, 30, 10].map((room) => plain(segments, room))).toEqual([
      full,
      "Stopping · Elapsed 1m 5s · 4 calls · 12.3k tokens · $0.04",
      "Stopping · Elapsed 1m 5s · 4 calls · 12.3k tokens",
      "Stopping · Elapsed 1m 5s · 12.3k tokens",
      "Stopping · Elapsed 1m 5s",
      "Stopping · Elapsed 1m 5s",
    ]);
  });

  it("paints the reason in error and the rest muted, joined by a muted dot", () => {
    expect(receiptText(receipt({ reason: "boom", elapsedMs: 2_000, running: false }), 80, tagged)).toBe(
      "<error>boom</><muted> · </><muted>2s</>",
    );
  });
});
