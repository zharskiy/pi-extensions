import { describe, expect, it } from "vitest";
import { createFakeHost, plainTheme } from "../../../test-framework/index.ts";
import { createTranscript } from "../api/plugin.ts";

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

    expect(host.thinkingLabels).toEqual([{ label: "Thinking", hint: "(<app.thinking.toggle> to expand)" }]);
  });

  it("gives the thinking label no hint when the toggle is unbound", () => {
    const host = createFakeHost({ mode: "tui" });

    host.ui.keyText = () => "";
    createTranscript(host);
    host.start();

    expect(host.thinkingLabels).toEqual([{ label: "Thinking" }]);
  });

  it.each(["print", "rpc", "json"] as const)("leaves the thinking label alone in %s mode", (mode) => {
    const host = createFakeHost({ mode });

    createTranscript(host);
    host.start();

    expect(host.thinkingLabels).toEqual([]);
  });
});
