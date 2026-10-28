import { describe, expect, it } from "vitest";
import { skillOfRead } from "../tools/skill-reads.ts";

const skill = (args: unknown, name = "read") => skillOfRead(name, args, "/repo", "/home/me");

describe("skillOfRead", () => {
  it.each([
    ["an absolute path", { path: "/x/skills/tdd/SKILL.md" }],
    ["file_path instead of path", { file_path: "/x/skills/tdd/SKILL.md" }],
    ["a relative path against the cwd", { path: "skills/tdd/SKILL.md" }],
    ["a home path", { path: "~/.pi/agent/skills/tdd/SKILL.md" }],
    ["an @ prefix", { path: "@/x/tdd/SKILL.md" }],
    ["a file URL", { path: "file:///x/tdd/SKILL.md" }],
  ])("finds the skill in %s", (_case, args) => {
    expect(skill(args)).toEqual({ name: "tdd" });
  });

  it("turns a non-breaking space in the folder name into a plain space", () => {
    expect(skill({ path: "/x/my skill/SKILL.md" })).toEqual({ name: "my skill" });
  });

  it.each([
    ["another file", "read", { path: "/x/tdd/mocking.md" }],
    ["a wrong-case name", "read", { path: "/x/tdd/skill.md" }],
    ["an edit", "edit", { path: "/x/tdd/SKILL.md" }],
    ["a write", "write", { path: "/x/tdd/SKILL.md" }],
    ["empty args", "read", {}],
    ["null args", "read", null],
    ["a non-string path", "read", { path: 3 }],
    ["an empty path", "read", { path: "" }],
  ])("finds nothing for %s", (_case, name, args) => {
    expect(skill(args, name)).toBeUndefined();
  });
});
