import { describe, expect, it } from "vitest";
import { completeArgs, parseArgs } from "../src/args.ts";

describe("mcp-import arguments", () => {
  it("defaults to a user-scope dry run", () => {
    expect(parseArgs("claude")).toEqual({ source: "claude", scope: "user", apply: false });
  });

  it("reads project and apply in any order", () => {
    expect(parseArgs(" cursor apply  project ")).toEqual({ source: "cursor", scope: "project", apply: true });
  });

  it("asks for the interactive choice without arguments", () => {
    expect(parseArgs("  ")).toEqual({ interactive: true });
  });

  it("rejects an unknown tool and unknown words", () => {
    expect(parseArgs("other")).toEqual({ error: expect.stringMatching(/^unknown tool "other"/) });
    expect(parseArgs("claude now")).toEqual({ error: expect.stringMatching(/^unknown argument "now"/) });
  });

  it("completes the tool, then the flags not yet given", () => {
    expect(completeArgs("c")).toEqual([
      { value: "claude", label: "claude" },
      { value: "cursor", label: "cursor" },
    ]);
    expect(completeArgs("claude ")).toEqual([
      { value: "claude project", label: "project" },
      { value: "claude apply", label: "apply" },
    ]);
    expect(completeArgs("claude apply p")).toEqual([{ value: "claude apply project", label: "project" }]);
    expect(completeArgs("x")).toBeNull();
  });
});
