import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { findServers } from "../core/sources.ts";

const temp = useTempDirs();

const places = () => {
  const root = temp.make("pi-mcp-import-");
  const home = join(root, "home");
  const cwd = join(root, "project");

  mkdirSync(join(home, ".cursor"), { recursive: true });
  mkdirSync(join(cwd, ".cursor"), { recursive: true });

  return { home, cwd, codexHome: join(home, ".codex") };
};

describe("source files", () => {
  it("reports a wrong mcpServers shape as a problem", () => {
    const { home, cwd, codexHome } = places();

    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: [] }));

    const found = findServers("cursor", "project", { home, cwd, codexHome });

    expect(found.origins).toEqual([]);
    expect(found.problems).toEqual([expect.stringMatching(/"mcpServers"/)]);
  });

  it("reads Claude's local scope under the real path of a symlinked project", () => {
    const { home, cwd, codexHome } = places();
    const link = join(dirname(cwd), "link");

    symlinkSync(cwd, link);
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [realpathSync(cwd)]: { mcpServers: { a: { command: "x" } } } } }),
    );

    expect(findServers("claude", "project", { home, cwd: link, codexHome }).origins[0].servers).toEqual({
      a: { command: "x" },
    });
  });

  it("finds nothing in Claude's local scope for another project", () => {
    const { home, cwd, codexHome } = places();

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { "/elsewhere": { mcpServers: { a: { command: "x" } } } } }),
    );

    expect(findServers("claude", "project", { home, cwd, codexHome }).origins[0].servers).toEqual({});
  });

  it("reads Claude's user scope from the top level of ~/.claude.json", () => {
    const { home, cwd, codexHome } = places();

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: { u: { command: "u" } },
        projects: { [cwd]: { mcpServers: { l: { command: "l" } } } },
      }),
    );

    expect(findServers("claude", "user", { home, cwd, codexHome }).origins).toEqual([
      { label: "~/.claude.json (user scope)", servers: { u: { command: "u" } } },
    ]);
  });

  it("reads Claude's local scope before .mcp.json for a project import", () => {
    const { home, cwd, codexHome } = places();

    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ projects: { [cwd]: { mcpServers: { l: { command: "l" } } } } }),
    );
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { p: { command: "p" } } }));

    expect(
      findServers("claude", "project", { home, cwd, codexHome }).origins.map((origin) => origin.label),
    ).toEqual(["~/.claude.json (local scope of this project)", ".mcp.json"]);
  });

  it("reads Cursor's user and project files", () => {
    const { home, cwd, codexHome } = places();

    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { u: { command: "u" } } }));
    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { p: { command: "p" } } }));

    expect(findServers("cursor", "user", { home, cwd, codexHome }).origins[0].servers).toEqual({
      u: { command: "u" },
    });
    expect(findServers("cursor", "project", { home, cwd, codexHome }).origins[0].servers).toEqual({
      p: { command: "p" },
    });
  });

  it("treats missing files as empty and reports unreadable ones", () => {
    const { home, cwd, codexHome } = places();

    expect(findServers("cursor", "user", { home, cwd, codexHome })).toEqual({
      origins: [],
      checked: ["~/.cursor/mcp.json"],
      problems: [],
    });

    writeFileSync(join(home, ".cursor", "mcp.json"), "{");

    expect(findServers("cursor", "user", { home, cwd, codexHome }).problems).toEqual([
      expect.stringMatching(/^cannot read .*mcp\.json: /),
    ]);
  });

  it("reads Codex's user file with quoted names, multi-line arrays and nested tables", () => {
    const { home, cwd, codexHome } = places();

    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model = "x"',
        '[mcp_servers."a.b"]',
        'command = "npx"',
        "args = [",
        '  "-y",',
        "]",
        "[mcp_servers.docs]",
        'url = "https://x.test/mcp"',
        'http_headers = { "X-Client" = "pinata" }',
        "[mcp_servers.docs.oauth]",
        'client_id = "id"',
      ].join("\n"),
    );

    expect(findServers("codex", "user", { home, cwd, codexHome }).origins).toEqual([
      {
        label: "~/.codex/config.toml",
        servers: {
          "a.b": { command: "npx", args: ["-y"] },
          docs: {
            url: "https://x.test/mcp",
            http_headers: { "X-Client": "pinata" },
            oauth: { client_id: "id" },
          },
        },
      },
    ]);
  });

  it("names a CODEX_HOME outside the home folder by its full path", () => {
    const { home, cwd } = places();
    const codexHome = join(dirname(home), "codex");

    expect(findServers("codex", "user", { home, cwd, codexHome }).checked).toEqual([
      join(codexHome, "config.toml"),
    ]);
  });

  it("reads Codex's project file from the working directory only", () => {
    const { home, cwd, codexHome } = places();
    const inner = join(cwd, "inner");

    mkdirSync(join(inner, ".codex"), { recursive: true });
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(join(cwd, ".codex", "config.toml"), '[mcp_servers.outer]\ncommand = "o"\n');
    writeFileSync(join(inner, ".codex", "config.toml"), '[mcp_servers.inner]\ncommand = "i"\n');

    expect(findServers("codex", "project", { home, cwd: inner, codexHome }).origins).toEqual([
      { label: ".codex/config.toml", servers: { inner: { command: "i" } } },
    ]);
  });

  it("reports bad TOML by line and column without quoting the file", () => {
    const { home, cwd, codexHome } = places();

    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), '[mcp_servers.a]\nenv = { TOKEN = "secret" }\nx = = 1\n');

    const [problem] = findServers("codex", "user", { home, cwd, codexHome }).problems;

    expect(problem).toMatch(/^cannot read .*config\.toml: invalid TOML at line 3, column \d+$/);
    expect(problem).not.toContain("secret");
  });

  it("reports an mcp_servers that is not a table and reads a file without one as empty", () => {
    const { home, cwd, codexHome } = places();

    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "config.toml"), "mcp_servers = 1\n");

    expect(findServers("codex", "user", { home, cwd, codexHome }).problems).toEqual([
      expect.stringMatching(/"mcp_servers"/),
    ]);

    writeFileSync(join(codexHome, "config.toml"), 'model = "x"\n');

    expect(findServers("codex", "user", { home, cwd, codexHome }).origins).toEqual([
      { label: "~/.codex/config.toml", servers: {} },
    ]);
  });
});
