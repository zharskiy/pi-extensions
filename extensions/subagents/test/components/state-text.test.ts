import { describe, expect, it } from "vitest";
import { stateGlyph, stateToken, stateWord } from "../../src/components/state-text.ts";
import type { AgentState } from "../../src/model/types.ts";

const TABLE: [AgentState, string, string, string][] = [
  ["queued", "queued", "○", "muted"],
  ["running", "running", "⠹", "accent"],
  ["grace", "stopping", "◐", "warning"],
  ["done", "done", "✓", "success"],
  ["failed", "failed", "✗", "error"],
  ["stopped", "stopped", "■", "muted"],
  ["handoff", "handed off", "↪", "warning"],
];

describe("state text", () => {
  it("maps every state to its glyph, token and word", () => {
    TABLE.forEach(([state, word, glyph, token]) => {
      expect(stateWord(state)).toBe(word);
      expect(stateGlyph(state, 250)).toBe(glyph);
      expect(stateToken(state)).toBe(token);
    });

    expect(stateGlyph("running", 250)).toBe("⠹");
    expect(stateGlyph("done", 0)).toBe("✓");
    expect(stateWord("handoff")).toBe("handed off");
    expect(stateToken("grace")).toBe("warning");
  });
});
