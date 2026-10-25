import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    it("adds a rule with the run's duration after a run that used tools", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 2, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(42_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host)).toHaveLength(1);

      const [entry] = answers(host);

      expect(host.renderEntry(ANSWER, entry?.data, { width: 40 })).toEqual([
        `── worked 42s ${"─".repeat(26)}`,
      ]);
    });

    it("adds nothing for an answer without tools", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host)).toEqual([]);
    });

    it("adds nothing when the final message has no text", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: false });

      expect(answers(host)).toEqual([]);
    });

    it("keeps the run across a retry and times the rule from the first start", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 3, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(20_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "error", text: false });
      host.agentStart();
      vi.advanceTimersByTime(22_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host).map((entry) => entry.data)).toEqual([{ ms: 42_000 }]);
    });

    it("starts a new run after idle", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      vi.advanceTimersByTime(30_000);
      host.settle();
      host.agentStart();
      vi.advanceTimersByTime(5_000);
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(1_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host).map((entry) => entry.data)).toEqual([{ ms: 0 }, { ms: 6_000 }]);
    });

    it.each(["aborted", "error", "length"] as const)(
      "adds nothing when the final message stops with %s",
      (stopReason) => {
        const host = tuiHost();

        host.agentStart();
        host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
        host.assistantEnd({ toolCalls: 0, stopReason, text: true });

        expect(answers(host)).toEqual([]);
      },
    );

    it("adds a second rule only when tools ran after the first, timed from it", () => {
      const host = tuiHost();

      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(10_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });
      vi.advanceTimersByTime(5_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host)).toHaveLength(1);

      vi.advanceTimersByTime(3_000);
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      vi.advanceTimersByTime(4_000);
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host).map((entry) => entry.data)).toEqual([{ ms: 10_000 }, { ms: 12_000 }]);
    });

    it.each(["print", "rpc", "json"] as const)("adds nothing in %s mode", (mode) => {
      const host = createFakeHost({ mode });

      createTranscript(host);
      host.start();
      host.agentStart();
      host.assistantEnd({ toolCalls: 1, stopReason: "toolUse", text: true });
      host.assistantEnd({ toolCalls: 0, stopReason: "stop", text: true });

      expect(answers(host)).toEqual([]);
    });

    it.each([null, "x", { ms: -1 }])("draws nothing for malformed data %j", (data) => {
      const host = tuiHost();

      expect(host.renderEntry(ANSWER, data, { width: 40 })).toEqual([]);
    });
  });
});
