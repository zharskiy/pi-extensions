import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findServers } from "../core/sources.ts";

const roots: string[] = [];

const places = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-import-"));
  const home = join(root, "home");
  const cwd = join(root, "project");

  roots.push(root);
  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(cwd, ".cursor"), { recursive: true });

  return { home, cwd };
};

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("source files", () => {
  it("reports a wrong mcpServers shape as a problem", () => {
    const { home, cwd } = places();

    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: [] }));

    const found = findServers("cursor", "project", { home, cwd });

    expect(found.origins).toEqual([]);
    expect(found.problems).toEqual([expect.stringMatching(/"mcpServers"/)]);
  });

  it("reads Claude's local scope under the real path of a symlinked project", () => {
    const { home, cwd } = places();
    const link = join(dirname(cwd), "link");

    symlinkSync(cwd, link);
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [realpathSync(cwd)]: { mcpServers: { a: { command: "x" } } } } }),
    );

    expect(findServers("claude", "project", { home, cwd: link }).origins[0].servers).toEqual({
      a: { command: "x" },
    });
  });

  it("finds nothing in Claude's local scope for another project", () => {
    const { home, cwd } = places();

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { "/elsewhere": { mcpServers: { a: { command: "x" } } } } }),
    );

    expect(findServers("claude", "project", { home, cwd }).origins[0].servers).toEqual({});
  });

  it("reads Claude's user scope from the top level of ~/.claude.json", () => {
    const { home, cwd } = places();

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { u: { command: "u" } },
        projects: { [cwd]: { mcpServers: { l: { command: "l" } } } },
      }),
    );

    expect(findServers("claude", "user", { home, cwd }).origins).toEqual([
      { label: "~/.claude.json (user scope)", servers: { u: { command: "u" } } },
    ]);
  });

  it("reads Claude's local scope before .mcp.json for a project import", () => {
    const { home, cwd } = places();

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [cwd]: { mcpServers: { l: { command: "l" } } } } }),
    );
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { p: { command: "p" } } }));

    expect(findServers("claude", "project", { home, cwd }).origins.map((origin) => origin.label)).toEqual([
      "~/.claude.json (local scope of this project)",
      ".mcp.json",
    ]);
  });

  it("reads Cursor's user and project files", () => {
    const { home, cwd } = places();

    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { u: { command: "u" } } }));
    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { p: { command: "p" } } }));

    expect(findServers("cursor", "user", { home, cwd }).origins[0].servers).toEqual({ u: { command: "u" } });
    expect(findServers("cursor", "project", { home, cwd }).origins[0].servers).toEqual({
      p: { command: "p" },
    });
  });

  it("treats missing files as empty and reports unreadable ones", () => {
    const { home, cwd } = places();

    expect(findServers("cursor", "user", { home, cwd })).toEqual({
      origins: [],
      checked: ["~/.cursor/mcp.json"],
      problems: [],
    });

    writeFileSync(join(home, ".cursor", "mcp.json"), "{");

    expect(findServers("cursor", "user", { home, cwd }).problems).toEqual([
      expect.stringMatching(/^cannot read .*mcp\.json: /),
    ]);
  });
});
