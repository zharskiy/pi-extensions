import { describe, expect, it } from "vitest";
import { completePath } from "../../../cli/prompt/complete.ts";

const TREE: Record<string, string[]> = {
  "/home/me": ["Pictures", "Projects", "Public", ".config"],
  "/Volumes": ["Code"],
};

const readdir = (dir: string) => TREE[dir] ?? [];

describe("completePath", () => {
  it("completes a single match with a slash and keeps the ~/ form", () => {
    expect(completePath("~/Pi", "/home/me", readdir)).toEqual({ value: "~/Pictures/", matches: [] });

    expect(completePath("/Volumes/C", "/home/me", readdir)).toEqual({ value: "/Volumes/Code/", matches: [] });

    expect(completePath("~", "/home/me", readdir)).toEqual({ value: "~/", matches: [] });
  });

  it("completes the common prefix and returns every match", () => {
    expect(completePath("~/P", "/home/me", readdir)).toEqual({
      value: "~/P",
      matches: ["~/Pictures/", "~/Projects/", "~/Public/"],
    });

    expect(completePath("~/Pu", "/home/me", readdir).value).toBe("~/Public/");
  });

  it("offers hidden folders only for a leading dot, and nothing for relative or unreadable paths", () => {
    expect(completePath("~/", "/home/me", readdir).matches).not.toContain("~/.config/");

    expect(completePath("~/.", "/home/me", readdir).value).toBe("~/.config/");

    expect(completePath("rel/x", "/home/me", readdir)).toEqual({ value: "rel/x", matches: [] });

    const failing = () => {
      throw new Error("EACCES");
    };

    expect(completePath("/root/x", "/home/me", failing)).toEqual({ value: "/root/x", matches: [] });
  });
});
