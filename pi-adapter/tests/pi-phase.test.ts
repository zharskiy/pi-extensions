import { describe, expect, it } from "vitest";
import {
  deltaEvent,
  initialPhase,
  type PhaseEvent,
  type PhaseState,
  reducePhase,
} from "../runtime/pi-phase.ts";

const run = (events: PhaseEvent[], from: PhaseState = initialPhase()) => events.reduce(reducePhase, from);

const delta = (type: string) => deltaEvent(type) as PhaseEvent;

const toolStart = (id: string): PhaseEvent => ({ type: "tool_start", id });

const toolEnd = (id: string): PhaseEvent => ({ type: "tool_end", id });

const view = (state: PhaseState) => ({ phase: state.phase, running: [...state.running] });

describe("reducePhase", () => {
  it("starts idle", () => {
    expect(view(initialPhase())).toEqual({ phase: "idle", running: [] });
  });

  it("enters waiting on agent_start and clears running tools", () => {
    const state = run([{ type: "agent_start" }, toolStart("a"), { type: "agent_start" }]);

    expect(view(state)).toEqual({ phase: "waiting", running: [] });
  });

  it("enters waiting on turn_start", () => {
    expect(run([{ type: "agent_start" }, delta("text_delta"), { type: "turn_start" }]).phase).toBe("waiting");
  });

  it("maps assistant deltas to writing, thinking and toolArgs and *_end back to waiting", () => {
    const phaseAfter = (type: string) => run([{ type: "agent_start" }, delta(type)]).phase;

    expect(phaseAfter("text_start")).toBe("writing");
    expect(phaseAfter("text_delta")).toBe("writing");
    expect(phaseAfter("thinking_start")).toBe("thinking");
    expect(phaseAfter("thinking_delta")).toBe("thinking");
    expect(phaseAfter("toolcall_start")).toBe("toolArgs");
    expect(phaseAfter("toolcall_delta")).toBe("toolArgs");
    expect(run([{ type: "agent_start" }, delta("text_delta"), delta("text_end")]).phase).toBe("waiting");
    expect(run([{ type: "agent_start" }, delta("thinking_delta"), delta("thinking_end")]).phase).toBe(
      "waiting",
    );
    expect(run([{ type: "agent_start" }, delta("toolcall_delta"), delta("toolcall_end")]).phase).toBe(
      "waiting",
    );
  });

  it("maps no other assistant event", () => {
    expect(deltaEvent("start")).toBeUndefined();
    expect(deltaEvent("done")).toBeUndefined();
    expect(deltaEvent("error")).toBeUndefined();
  });

  it("enters waiting on message_end", () => {
    expect(run([{ type: "agent_start" }, delta("text_delta"), { type: "message_end" }]).phase).toBe(
      "waiting",
    );
  });

  it("enters tool on a top-level tool start", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a")]))).toEqual({ phase: "tool", running: ["a"] });
  });

  it("returns to waiting when the last tool ends", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a"), toolEnd("a")]))).toEqual({
      phase: "waiting",
      running: [],
    });
  });

  it("ignores the end of an unknown tool", () => {
    const state = run([{ type: "agent_start" }, toolStart("a")]);

    expect(reducePhase(state, toolEnd("other"))).toBe(state);
  });

  it("enters waiting on agent_end and clears running tools", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a"), { type: "agent_end" }]))).toEqual({
      phase: "waiting",
      running: [],
    });
  });

  it("enters idle on agent_settled", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a"), { type: "agent_settled" }]))).toEqual({
      phase: "idle",
      running: [],
    });
  });

  it("stays in tool while parallel calls drain", () => {
    const both = run([{ type: "agent_start" }, toolStart("a"), toolStart("b")]);

    expect(view(both)).toEqual({ phase: "tool", running: ["a", "b"] });
    expect(view(reducePhase(both, toolEnd("b")))).toEqual({ phase: "tool", running: ["a"] });
    expect(view(reducePhase(both, toolEnd("a")))).toEqual({ phase: "tool", running: ["b"] });
    expect(run([toolEnd("a"), toolEnd("b")], both).phase).toBe("waiting");
  });

  it("stays in the run when a follow-up starts a new turn", () => {
    const state = run([
      { type: "agent_start" },
      delta("text_delta"),
      { type: "message_end" },
      { type: "turn_start" },
    ]);

    expect(state.phase).toBe("waiting");
  });

  it("clears running tools on turn_start after an aborted tool", () => {
    const aborted = run([{ type: "agent_start" }, toolStart("a"), toolStart("b"), toolEnd("a")]);

    const next = reducePhase(aborted, { type: "turn_start" });

    expect(view(next)).toEqual({ phase: "waiting", running: [] });
    expect(run([toolStart("c"), toolEnd("c")], next).phase).toBe("waiting");
  });

  it("keeps waiting between agent_end and agent_settled", () => {
    const ended = run([{ type: "agent_start" }, { type: "agent_end" }]);

    expect(reducePhase(ended, { type: "agent_start" })).toBe(ended);
    expect(reducePhase(ended, { type: "agent_end" })).toBe(ended);
  });
});
