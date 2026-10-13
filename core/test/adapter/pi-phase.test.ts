import { describe, expect, it } from "vitest";
import {
  deltaEvent,
  detailOf,
  initialPhase,
  type PhaseEvent,
  type PhaseState,
  reducePhase,
} from "../../adapter/pi-phase.ts";

const run = (events: PhaseEvent[], from: PhaseState = initialPhase()) => events.reduce(reducePhase, from);

const delta = (type: string) => deltaEvent(type) as PhaseEvent;

const toolStart = (id: string, name: string): PhaseEvent => ({ type: "tool_start", id, name });

const toolEnd = (id: string): PhaseEvent => ({ type: "tool_end", id });

const view = (state: PhaseState) => ({ phase: state.phase, detail: detailOf(state) });

describe("reducePhase", () => {
  it("starts idle", () => {
    expect(view(initialPhase())).toEqual({ phase: "idle", detail: { running: 0 } });
  });

  it("enters waiting on agent_start and clears running tools", () => {
    const state = run([{ type: "agent_start" }, toolStart("a", "bash"), { type: "agent_start" }]);

    expect(view(state)).toEqual({ phase: "waiting", detail: { running: 0 } });
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

  it("enters tool on a top-level tool start with its name", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash")]))).toEqual({
      phase: "tool",
      detail: { toolName: "bash", running: 1 },
    });
  });

  it("returns to waiting when the last tool ends", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash"), toolEnd("a")]))).toEqual({
      phase: "waiting",
      detail: { running: 0 },
    });
  });

  it("ignores the end of an unknown tool", () => {
    const state = run([{ type: "agent_start" }, toolStart("a", "bash")]);

    expect(reducePhase(state, toolEnd("other"))).toBe(state);
  });

  it("enters waiting on agent_end and clears running tools", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash"), { type: "agent_end" }]))).toEqual({
      phase: "waiting",
      detail: { running: 0 },
    });
  });

  it("enters idle on agent_settled", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash"), { type: "agent_settled" }]))).toEqual({
      phase: "idle",
      detail: { running: 0 },
    });
  });

  it("enters idle on shutdown", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash"), { type: "shutdown" }]))).toEqual({
      phase: "idle",
      detail: { running: 0 },
    });
  });

  it("keeps tool with the last running tool while parallel calls drain", () => {
    const both = run([{ type: "agent_start" }, toolStart("a", "bash"), toolStart("b", "grep")]);

    expect(detailOf(both)).toEqual({ toolName: "grep", running: 2 });
    expect(view(reducePhase(both, toolEnd("b")))).toEqual({
      phase: "tool",
      detail: { toolName: "bash", running: 1 },
    });
    expect(view(reducePhase(both, toolEnd("a")))).toEqual({
      phase: "tool",
      detail: { toolName: "grep", running: 1 },
    });
  });

  it("keeps codemode as the tool while nested calls run (filtered in the adapter)", () => {
    const outer = run([{ type: "agent_start" }, toolStart("outer", "codemode")]);

    expect(view(outer)).toEqual({ phase: "tool", detail: { toolName: "codemode", running: 1 } });
  });

  it("stays waiting across a repeated agent_start", () => {
    const waiting = run([{ type: "agent_start" }, { type: "turn_start" }]);
    const again = reducePhase(waiting, { type: "agent_start" });

    expect(again).toBe(waiting);
    expect(again.phase).toBe("waiting");
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

  it("returns the same state for a no-op delta", () => {
    const writing = run([{ type: "agent_start" }, delta("text_start")]);

    expect(reducePhase(writing, delta("text_delta"))).toBe(writing);
  });

  it("returns the same state for a repeated tool start", () => {
    const state = run([{ type: "agent_start" }, toolStart("a", "bash")]);

    expect(reducePhase(state, toolStart("a", "bash"))).toBe(state);
  });

  it("emits the agent_start and turn_start pair once", () => {
    const started = run([{ type: "agent_start" }]);

    expect(reducePhase(started, { type: "turn_start" })).toBe(started);
  });

  it("clears running tools on turn_start after an aborted tool", () => {
    const aborted = run([
      { type: "agent_start" },
      toolStart("a", "bash"),
      toolStart("b", "grep"),
      toolEnd("a"),
    ]);

    expect(view(reducePhase(aborted, { type: "turn_start" }))).toEqual({
      phase: "waiting",
      detail: { running: 0 },
    });
  });

  it("keeps waiting between agent_end and agent_settled", () => {
    const ended = run([{ type: "agent_start" }, { type: "agent_end" }]);

    expect(reducePhase(ended, { type: "agent_start" })).toBe(ended);
    expect(reducePhase(ended, { type: "agent_end" })).toBe(ended);
  });
});
