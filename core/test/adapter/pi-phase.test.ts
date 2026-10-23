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

const toolStart = (id: string, name: string): PhaseEvent => ({
  type: "tool_start",
  id,
  tool: { name, args: { id } },
});

const running = (...pairs: [id: string, name: string][]) => ({
  toolName: pairs.at(-1)?.[1],
  tools: pairs.map(([id, name]) => ({ name, args: { id } })),
});

const toolEnd = (id: string): PhaseEvent => ({ type: "tool_end", id });

const view = (state: PhaseState) => ({ phase: state.phase, detail: detailOf(state) });

describe("reducePhase", () => {
  it("starts idle", () => {
    expect(view(initialPhase())).toEqual({ phase: "idle", detail: {} });
  });

  it("enters waiting on agent_start and clears running tools", () => {
    const state = run([{ type: "agent_start" }, toolStart("a", "bash"), { type: "agent_start" }]);

    expect(view(state)).toEqual({ phase: "waiting", detail: {} });
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

  it("enters tool on a top-level tool start with its name and arguments", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash")]))).toEqual({
      phase: "tool",
      detail: { toolName: "bash", tools: [{ name: "bash", args: { id: "a" } }] },
    });
  });

  it("keeps the label of a running tool", () => {
    const state = run([
      { type: "agent_start" },
      { type: "tool_start", id: "m", tool: { name: "mcp__notes__search", args: {}, label: "notes/search" } },
    ]);

    expect(detailOf(state).tools).toEqual([{ name: "mcp__notes__search", args: {}, label: "notes/search" }]);
  });

  it("returns to waiting when the last tool ends", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash"), toolEnd("a")]))).toEqual({
      phase: "waiting",
      detail: {},
    });
  });

  it("ignores the end of an unknown tool", () => {
    const state = run([{ type: "agent_start" }, toolStart("a", "bash")]);

    expect(reducePhase(state, toolEnd("other"))).toBe(state);
  });

  it("enters waiting on agent_end and clears running tools", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash"), { type: "agent_end" }]))).toEqual({
      phase: "waiting",
      detail: {},
    });
  });

  it("enters idle on agent_settled", () => {
    expect(view(run([{ type: "agent_start" }, toolStart("a", "bash"), { type: "agent_settled" }]))).toEqual({
      phase: "idle",
      detail: {},
    });
  });

  it("keeps tool with the last running tool while parallel calls drain", () => {
    const both = run([{ type: "agent_start" }, toolStart("a", "bash"), toolStart("b", "grep")]);

    expect(detailOf(both)).toEqual(running(["a", "bash"], ["b", "grep"]));
    expect(view(reducePhase(both, toolEnd("b")))).toEqual({
      phase: "tool",
      detail: running(["a", "bash"]),
    });
    expect(view(reducePhase(both, toolEnd("a")))).toEqual({
      phase: "tool",
      detail: running(["b", "grep"]),
    });
  });

  it("keeps codemode as the tool while nested calls run (filtered in the adapter)", () => {
    const outer = run([{ type: "agent_start" }, toolStart("outer", "codemode")]);

    expect(view(outer)).toEqual({ phase: "tool", detail: running(["outer", "codemode"]) });
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
    const aborted = run([
      { type: "agent_start" },
      toolStart("a", "bash"),
      toolStart("b", "grep"),
      toolEnd("a"),
    ]);

    const next = reducePhase(aborted, { type: "turn_start" });

    expect(view(next)).toEqual({ phase: "waiting", detail: {} });
    expect(run([toolStart("c", "read"), toolEnd("c")], next).phase).toBe("waiting");
  });

  it("keeps waiting between agent_end and agent_settled", () => {
    const ended = run([{ type: "agent_start" }, { type: "agent_end" }]);

    expect(reducePhase(ended, { type: "agent_start" })).toBe(ended);
    expect(reducePhase(ended, { type: "agent_end" })).toBe(ended);
  });
});
