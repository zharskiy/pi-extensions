import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThemeLike, ToolRender, ToolRenderState } from "../../../../../pi-adapter/index.ts";
import { plainTheme, tokenTaggingTheme } from "../../../../../test-framework/index.ts";
import type { AgentRegistry, HandoffService } from "../../../src/model/types.ts";
import { handoffTool } from "../../../src/plugins/run-agent/handoff-tool.ts";

const tool = handoffTool(
  {
    registry: {
      get: () => ({ handoffPath: join(homedir(), "work", "handoff.md") }),
    } as unknown as AgentRegistry,
    handoff: {} as HandoffService,
  },
  "worker-1",
);

const state = (patch: Partial<ToolRenderState> = {}): ToolRenderState => ({
  aborted: false,
  expanded: false,
  isPartial: false,
  isError: false,
  args: {},
  invalidate: () => {},
  ...patch,
});

const drawn = (render: ToolRender | undefined) => (typeof render === "function" ? render(80) : render);

const tagged: ThemeLike = tokenTaggingTheme({ close: () => "" });

describe("handoff tool rows", () => {
  it("draws the bold title as a row", () => {
    expect(tool.renderShell).toBe("row");
    expect(drawn(tool.renderCall?.({ content: "" }, plainTheme, state()))).toBe("✓ handoff");
  });

  it("names the saved file under the home directory, or the error lines", () => {
    expect(drawn(tool.renderResult?.({ text: "Handoff saved" }, state(), plainTheme))).toBe(
      "  ↳ Saved ~/work/handoff.md",
    );
    expect(drawn(tool.renderResult?.({ text: "Error: bad\nmore", isError: true }, state(), tagged))).toBe(
      ["  <dim>↳ <error>Error: bad", "    <error>more"].join("\n"),
    );
  });
});
