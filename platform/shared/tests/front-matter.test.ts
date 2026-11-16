import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../index.ts";

describe("frontmatter", () => {
  it("parses scalars, inline lists, block lists and block text", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "name: scout",
        'description: "Finds things: fast"',
        "tools: [read, grep]",
        "skills:",
        "  - search",
        "  - 'docs'",
        "limit: 12000",
        "prompt: |",
        "  line one",
        "  line two",
        "unknownKey: ignored-but-kept",
        "---",
        "Body text.",
      ].join("\n"),
    );

    expect(parsed.data).toEqual({
      name: "scout",
      description: "Finds things: fast",
      tools: ["read", "grep"],
      skills: ["search", "docs"],
      limit: 12000,
      prompt: "line one\nline two",
      unknownKey: "ignored-but-kept",
    });

    expect(parsed.body).toBe("Body text.");
  });

  it("treats a file without frontmatter as body only", () => {
    expect(parseFrontmatter("just text")).toEqual({ data: {}, body: "just text" });
  });

  it("closes the header at a --- line with trailing spaces, CRLF or none after it", () => {
    expect(parseFrontmatter("---\r\ndescription: crlf\r\n---  \r\nBody")).toEqual({
      data: { description: "crlf" },
      body: "Body",
    });
    expect(parseFrontmatter("---\nname: x\n---")).toEqual({ data: { name: "x" }, body: "" });
    expect(parseFrontmatter("---\nname: x\n---more\n")).toEqual({ data: {}, body: "---\nname: x\n---more" });
  });
});
