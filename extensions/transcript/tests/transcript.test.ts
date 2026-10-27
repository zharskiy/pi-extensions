import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_WORK_CHANNEL } from "../../../platform/shared/index.ts";
import { createFakeHost, plainTheme } from "../../../test/framework/index.ts";
import { createTranscript } from "../api/plugin.ts";

const ANSWER = "pi-transcript:answer";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

const tuiHost = () => {
  const host = createFakeHost({ mode: "tui" });

  createTranscript(host);
  host.start();

  return host;
};

const answers = (host: ReturnType<typeof tuiHost>) =>
  host.entries.filter((entry) => entry.customType === ANSWER);

describe("transcript", () => {
  it("registers the tool rows at load, with the expand key the host names", () => {
    const host = createFakeHost();

    createTranscript(host, "/home/me");

    const row = host.toolRows?.({
      name: "bash",
      args: { command: "ls" },
      argsComplete: true,
      started: true,
      isPartial: false,
      isError: false,
      expanded: false,
      cwd: "/repo",
      aborted: false,
      result: { text: "a\nb\nc\nd", images: 0 },
    });

    expect(row?.call(40, plainTheme)).toEqual(["✓ bash ls"]);
    expect(row?.result?.(60, plainTheme)[0]).toBe("  ↳ ... (1 earlier line, <app.tools.expand> to expand)");
  });

  it("sets the thinking label with the toggle hint at a tui session start", () => {
    const host = createFakeHost({ mode: "tui" });

    createTranscript(host);

    expect(host.thinkingLabels).toEqual([]);

    host.start();

    expect(host.thinkingLabels).toEqual([{ label: "∴ Thinking", hint: "(<app.thinking.toggle> to expand)" }]);
  });

  it("gives the thinking label no hint when the toggle is unbound", () => {
    const host = createFakeHost({ mode: "tui" });

    host.ui.keyText = () => "";
    createTranscript(host);
    host.start();

    expect(host.thinkingLabels).toEqual([{ label: "∴ Thinking" }]);
  });

  it.each(["print", "rpc", "json"] as const)("leaves the thinking label alone in %s mode", (mode) => {
    const host = createFakeHost({ mode });

    createTranscript(host);
    host.start();

    expect(host.thinkingLabels).toEqual([]);
  });

  describe("answer rule", () => {
    const work = (host: ReturnType<typeof tuiHost>, count: number, source = "pi-subagents") =>
      host.emit(BACKGROUND_WORK_CHANNEL, { source, count });

    const durations = (host: ReturnType<typeof tuiHost>) => answers(host).map((entry) => entry.data);

    const chat = (host: ReturnType<typeof tuiHost>) =>
      host.chat.map((item) =>
        item.kind === "assistant"
          ? item.text
          : (host.renderEntry(item.customType, item.data, { width: 30 })[0] ?? "").replaceAll("─", "").trim(),
      );

    it("draws the rule right above the final answer of a turn that used tools", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 2, text: "looking" });
      vi.advanceTimersByTime(42_000);
      host.assistantEnd({ text: "both tests pass now" });

      expect(chat(host)).toEqual(["looking", "worked 42s", "both tests pass now"]);

      const [entry] = answers(host);

      expect(host.renderEntry(ANSWER, entry?.data, { width: 40 })).toEqual([
        `── worked 42s ${"─".repeat(26)}`,
      ]);

      host.settle();

      expect(answers(host)).toHaveLength(1);
    });

    it("draws it above the last reply of the settled turn, not above replies made while agents still ran", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, text: "spawning" });
      work(host, 1);
      host.assistantEnd({ text: "Started 5 agents" });
      host.settle();
      vi.advanceTimersByTime(60_000);
      host.agentStart();
      work(host, 2);
      host.assistantEnd({ toolCalls: 1, text: "checking" });
      work(host, 1);
      host.assistantEnd({ text: "All 20 agents completed" });
      host.settle();
      vi.advanceTimersByTime(30_000);
      host.agentStart();
      work(host, 0);
      host.assistantEnd({ text: "All 15 checks succeeded" });
      host.settle();

      expect(chat(host)).toEqual([
        "spawning",
        "Started 5 agents",
        "checking",
        "All 20 agents completed",
        "worked 1m 30s",
        "All 15 checks succeeded",
      ]);
    });

    it("skips a reply after which the run goes on", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, text: "editing" });
      host.assistantEnd({ final: false, text: "done, but a message is queued" });
      host.assistantEnd({ text: "now really done" });
      host.settle();

      expect(chat(host)).toEqual([
        "editing",
        "done, but a message is queued",
        "worked 0s",
        "now really done",
      ]);
    });

    it("gives tool work that goes on in the same run after a final reply a turn of its own", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantStart();
      host.assistantEnd({ toolCalls: 1, text: "editing" });
      host.assistantStart();
      host.assistantEnd({ text: "done" });
      vi.advanceTimersByTime(1_000);
      host.assistantStart();
      vi.advanceTimersByTime(4_000);
      host.assistantEnd({ toolCalls: 1, text: "one more check" });
      host.assistantStart();
      host.assistantEnd({ final: false, text: "error" });
      host.settle();

      expect(chat(host)).toEqual(["editing", "worked 0s", "done", "one more check", "error", "worked 4s"]);
    });

    it("adds nothing for a turn that only answers", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ text: "hi" });
      host.settle();

      expect(answers(host)).toEqual([]);
    });

    it("keeps the turn across a retry and times the rule from the first start", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 3 });
      vi.advanceTimersByTime(20_000);
      host.assistantEnd({ final: false, text: "overloaded" });
      host.agentStart();
      vi.advanceTimersByTime(22_000);
      host.assistantEnd({ text: "answer" });
      host.settle();

      expect(durations(host)).toEqual([{ ms: 42_000 }]);
      expect(chat(host).slice(-2)).toEqual(["worked 42s", "answer"]);
    });

    it("adds the rule at the end when the turn settles without a final answer to draw it above", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, text: "trying" });
      vi.advanceTimersByTime(5_000);
      host.assistantEnd({ final: false, text: "error" });
      host.settle();

      expect(chat(host)).toEqual(["trying", "error", "worked 5s"]);
    });

    it("adds the rule when the last pending work clears after the session went idle", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 1 });
      host.settle();
      host.agentStart();
      vi.advanceTimersByTime(30_000);
      host.assistantEnd();
      host.settle();

      expect(answers(host)).toEqual([]);

      work(host, 0);

      expect(durations(host)).toEqual([{ ms: 30_000 }]);
    });

    it("waits for every source of background work", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1, "one");
      work(host, 2, "two");
      host.assistantEnd({ toolCalls: 1 });
      host.settle();
      work(host, 0, "one");
      host.agentStart();
      host.assistantEnd({ text: "one is done" });
      host.settle();

      expect(answers(host)).toEqual([]);

      host.agentStart();
      work(host, 0, "two");
      host.assistantEnd({ text: "two is done" });

      expect(chat(host).slice(-2)).toEqual(["worked 0s", "two is done"]);
    });

    it("ignores a malformed background work report", () => {
      const host = tuiHost();

      host.agentStart();
      host.emit(BACKGROUND_WORK_CHANNEL, { source: "pi-subagents", count: "1" });
      host.assistantEnd({ toolCalls: 1 });
      host.assistantEnd();

      expect(answers(host)).toHaveLength(1);
    });

    it("joins a prompt typed while background work is pending to the same turn", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 1 });
      host.settle();
      vi.advanceTimersByTime(20_000);
      host.agentStart();
      host.assistantEnd();
      host.settle();
      vi.advanceTimersByTime(20_000);
      host.agentStart();
      work(host, 0);
      host.assistantEnd();
      host.settle();

      expect(durations(host)).toEqual([{ ms: 40_000 }]);
    });

    it("counts tools from every run of the turn", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd();
      host.settle();
      host.agentStart();
      host.assistantEnd({ toolCalls: 1 });
      work(host, 0);
      host.assistantEnd();
      host.settle();

      expect(answers(host)).toHaveLength(1);
    });

    it("starts a new turn after the last one was answered", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1 });
      vi.advanceTimersByTime(30_000);
      host.assistantEnd();
      host.settle();
      vi.advanceTimersByTime(60_000);
      host.agentStart();
      vi.advanceTimersByTime(5_000);
      host.assistantEnd({ toolCalls: 1 });
      vi.advanceTimersByTime(1_000);
      host.assistantEnd();
      host.settle();

      expect(durations(host)).toEqual([{ ms: 30_000 }, { ms: 6_000 }]);
    });

    it("ends the turn without a rule when the user aborts, even with work pending", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 2 });
      host.assistantEnd({ final: false });
      host.settle({ aborted: true });
      work(host, 0);

      expect(answers(host)).toEqual([]);

      vi.advanceTimersByTime(10_000);
      host.agentStart();
      vi.advanceTimersByTime(3_000);
      host.assistantEnd({ toolCalls: 1 });
      host.assistantEnd();
      host.settle();

      expect(durations(host)).toEqual([{ ms: 3_000 }]);
    });

    it.each(["print", "rpc", "json"] as const)("adds nothing in %s mode", (mode) => {
      const host = createFakeHost({ mode });

      createTranscript(host);
      host.start();
      host.agentStart();
      host.assistantEnd({ toolCalls: 1 });
      host.assistantEnd();
      host.settle();

      expect(answers(host)).toEqual([]);
    });

    it.each([null, "x", { ms: -1 }])("draws nothing for malformed data %j", (data) => {
      const host = tuiHost();

      expect(host.renderEntry(ANSWER, data, { width: 40 })).toEqual([]);
    });
  });
});
