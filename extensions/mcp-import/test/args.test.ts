import { describe, expect, it } from "vitest";
import { completeArgs, parseArgs } from "../src/args.ts";

describe("mcp-import arguments", () => {
  it("defaults to a user-scope dry run", () => {
    expect(parseArgs("claude")).toEqual({ source: "claude", scope: "user", apply: false });
  });

  it("reads project and apply in any order", () => {
    expect(parseArgs(" cursor apply  project ")).toEqual({ source: "cursor", scope: "project", apply: true });
  });

  it("rejects a missing or unknown tool and unknown words", () => {
    expect(parseArgs("")).toMatch(/^Name the tool/);
    expect(parseArgs("other")).toMatch(/^Unknown tool "other"/);
    expect(parseArgs("claude now")).toMatch(/^Unknown argument "now"/);
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
