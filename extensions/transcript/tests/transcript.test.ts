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

    it("adds a rule with the turn's duration once the session settles after a turn that used tools", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 2, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(42_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host)).toEqual([]);

      host.settle();

      expect(answers(host)).toHaveLength(1);

      const [entry] = answers(host);

      expect(host.renderEntry(ANSWER, entry?.data, { width: 40 })).toEqual([
        `── worked 42s ${"─".repeat(26)}`,
      ]);
    });

    it("adds nothing for a turn that only answers", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();

      expect(answers(host)).toEqual([]);
    });

    it("keeps the turn across a retry and times the rule from the first start", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 3, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(20_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "error", text: false });
      host.agentStart();
      vi.advanceTimersByTime(22_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();

      expect(durations(host)).toEqual([{ ms: 42_000 }]);
    });

    it("keeps the turn open across idle while background work is pending and adds the rule after the final answer", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      vi.advanceTimersByTime(10_000);
      host.settle();

      expect(answers(host)).toEqual([]);

      vi.advanceTimersByTime(50_000);
      host.agentStart();
      vi.advanceTimersByTime(5_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      work(host, 0);

      expect(answers(host)).toEqual([]);

      host.settle();

      expect(durations(host)).toEqual([{ ms: 65_000 }]);
    });

    it("adds the rule when the last pending work clears after the session went idle", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.settle();
      host.agentStart();
      vi.advanceTimersByTime(30_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
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
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.settle();
      work(host, 0, "one");

      expect(answers(host)).toEqual([]);

      work(host, 0, "two");

      expect(answers(host)).toHaveLength(1);
    });

    it("ignores a malformed background work report", () => {
      const host = tuiHost();

      host.agentStart();
      host.emit(BACKGROUND_WORK_CHANNEL, { source: "pi-subagents", count: "1" });
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.settle();

      expect(answers(host)).toHaveLength(1);
    });

    it("joins a prompt typed while background work is pending to the same turn", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.settle();
      vi.advanceTimersByTime(20_000);
      host.agentStart();
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();
      vi.advanceTimersByTime(20_000);
      host.agentStart();
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      work(host, 0);
      host.settle();

      expect(durations(host)).toEqual([{ ms: 40_000 }]);
    });

    it("counts tools from every run of the turn", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();
      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      work(host, 0);
      host.settle();

      expect(answers(host)).toHaveLength(1);
    });

    it("starts a new turn after the session settled", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      vi.advanceTimersByTime(30_000);
      host.settle();
      vi.advanceTimersByTime(60_000);
      host.agentStart();
      vi.advanceTimersByTime(5_000);
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(1_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();

      expect(durations(host)).toEqual([{ ms: 30_000 }, { ms: 6_000 }]);
    });

    it("ends the turn without a rule when the user aborts, even with work pending", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 2, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "aborted", text: false });
      host.settle({ aborted: true });
      work(host, 0);

      expect(answers(host)).toEqual([]);

      vi.advanceTimersByTime(10_000);
      host.agentStart();
      vi.advanceTimersByTime(3_000);
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();

      expect(durations(host)).toEqual([{ ms: 3_000 }]);
    });

    it.each(["error", "length"] as const)("adds the rule when the turn ends with a %s stop", (stopReason) => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason, text: false });
      host.settle();

      expect(answers(host)).toHaveLength(1);
    });

    it("starts fresh in a new session", () => {
      const host = tuiHost();

      host.agentStart();
      work(host, 1);
      host.assistantEnd({ toolCalls: 3, stopReason: "toolUse", text: true });
      host.start();
      work(host, 0);

      expect(answers(host)).toEqual([]);

      host.agentStart();
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();

      expect(answers(host)).toEqual([]);
    });

    it.each(["print", "rpc", "json"] as const)("adds nothing in %s mode", (mode) => {
      const host = createFakeHost({ mode });

      createTranscript(host);
      host.start();
      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      host.settle();

      expect(answers(host)).toEqual([]);
    });

    it.each([null, "x", { ms: -1 }])("draws nothing for malformed data %j", (data) => {
      const host = tuiHost();

      expect(host.renderEntry(ANSWER, data, { width: 40 })).toEqual([]);
    });
  });
});
