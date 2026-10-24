import { describe, expect, it } from "vitest";
import { plainTheme, tokenTaggingTheme } from "../../../../test-framework/index.ts";
import { displayWord } from "../../core/components/receipt.ts";
import type { AgentState } from "../../core/model/agent-record.ts";
import {
  liveGlyph,
  scrollGlyph,
  stateGlyph,
  stateToken,
  stateWord,
  stopWords,
} from "../../ui/components/state-text.ts";
import { agentRecord } from "../support/agent-records.ts";

const STATES: AgentState[] = ["queued", "running", "grace", "done", "failed", "stopped", "handoff"];

const tagged = tokenTaggingTheme({ close: (token) => `</${token}>` });

describe("agent state text", () => {
  it("draws the shared marks, with pi's spinner only for a running agent on a live surface", () => {
    expect(STATES.map((state) => stateGlyph(state, 0))).toEqual(["◌", "⠋", "◌", "✓", "✗", "⊘", "⊘"]);
    expect(stateGlyph("running", 250)).toBe("⠹");
    expect(STATES.map((state) => scrollGlyph(state, plainTheme))).toEqual([
      "◌",
      "◌",
      "◌",
      "✓",
      "✗",
      "⊘",
      "⊘",
    ]);
  });

  it("colours each state by its token", () => {
    expect(STATES.map(stateToken)).toEqual(["dim", "accent", "dim", "success", "error", "muted", "muted"]);
    expect(liveGlyph("running", 0, tagged)).toBe("<accent>⠋</accent>");
    expect(scrollGlyph("running", tagged)).toBe("<dim>◌</dim>");
    expect(scrollGlyph("handoff", tagged)).toBe("<muted>⊘</muted>");
  });

  it("gives display words in sentence case and keeps the lower-case model words", () => {
    const words = STATES.map((state) => displayWord(agentRecord({ id: "a", state, turns: 1 })));

    expect(words).toEqual(["Queued", undefined, "Stopping", undefined, undefined, "Stopped", "Handed off"]);
    expect(displayWord(agentRecord({ id: "a", state: "running" }))).toBe("Starting");
    expect(displayWord(agentRecord({ id: "a", state: "running", activity: "read" }))).toBeUndefined();
    expect(STATES.map(stateWord)).toEqual([
      "queued",
      "running",
      "stopping",
      "done",
      "failed",
      "stopped",
      "handed off",
    ]);
  });

  it("names what x does for the state", () => {
    const states: AgentState[] = ["running", "grace", "done"];

    expect(states.map(stopWords)).toEqual(["to stop", "to close now", "to clear"]);
  });
});
