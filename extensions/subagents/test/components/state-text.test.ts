import { describe, expect, it } from "vitest";
import { stateGlyph, stateSentence, stateToken, stateWord } from "../../src/components/state-text.ts";
import type { AgentState } from "../../src/model/types.ts";

const TABLE: [AgentState, string, string, string, string][] = [
  ["queued", "queued", "queued", "○", "muted"],
  ["running", "running", "running", "⠹", "accent"],
  ["grace", "stopping", "stopping", "◐", "warning"],
  ["done", "done", "finished", "✓", "success"],
  ["failed", "failed", "failed", "✗", "error"],
  ["stopped", "stopped", "was stopped", "■", "muted"],
  ["handoff", "handed off", "handed off", "↪", "warning"],
];

describe("state text", () => {
  it("maps every state to its glyph, token, word and sentence", () => {
    TABLE.forEach(([state, word, sentence, glyph, token]) => {
      expect(stateWord(state)).toBe(word);
      expect(stateSentence(state)).toBe(sentence);
      expect(stateGlyph(state, 250)).toBe(glyph);
      expect(stateToken(state)).toBe(token);
    });

    expect(stateGlyph("running", 250)).toBe("⠹");
    expect(stateGlyph("done", 0)).toBe("✓");
    expect(stateSentence("stopped")).toBe("was stopped");
    expect(stateWord("handoff")).toBe("handed off");
    expect(stateToken("grace")).toBe("warning");
  });
});
