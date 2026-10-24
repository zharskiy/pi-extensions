import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyPress } from "../../../pi-adapter/index.ts";
import { createFakeHost } from "../../../test-framework/index.ts";
import { createMcpImport } from "../api/plugin.ts";

const roots: string[] = [];

type Setup = {
  claude?: unknown;
  mcpJson?: unknown;
  cursorUser?: unknown;
  cursorProject?: unknown;
  existing?: unknown;
  projectTrusted?: boolean;
  mode?: "tui" | "rpc";
};

const setup = ({
  claude,
  mcpJson,
  cursorUser,
  cursorProject,
  existing,
  projectTrusted = true,
  mode = "tui",
}: Setup = {}) => {
  const root = mkdtempSync(join(tmpdir(), "pi-mcp-import-"));
  const home = join(root, "home");
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(root, "project");

  roots.push(root);
  mkdirSync(home, { recursive: true });
  mkdirSync(join(cwd, ".cursor"), { recursive: true });

  if (claude !== undefined) {
    writeFileSync(join(home, ".claude.json"), JSON.stringify(claude));
  }

  if (mcpJson !== undefined) {
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(mcpJson));
  }

  if (cursorUser !== undefined) {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify(cursorUser));
  }

  if (cursorProject !== undefined) {
    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify(cursorProject));
  }

  if (existing !== undefined) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(existing));
  }

  const host = createFakeHost({ agentDir, cwd, projectTrusted, mode });

  createMcpImport(host, home);
  host.start();

  return { host, userFile: join(agentDir, "mcp.json"), projectFile: join(cwd, ".pi", "mcp.json") };
};

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("/mcp-import", () => {
  it("prints what it would write and writes nothing without apply", async () => {
    const { host, userFile } = setup({
      claude: { mcpServers: { docs: { type: "http", url: "https://x.test/mcp" } } },
    });

    await host.runCommand("mcp-import", "claude");

    expect(existsSync(userFile)).toBe(false);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toContain(
      "pi-mcp-import: dry run of /mcp-import claude, nothing written",
    );
    expect(host.notices[0].message).toContain('"docs": {');
    expect(host.notices[0].message).toContain("sign in with /mcp");
    expect(host.notices[0].message).toContain("run /mcp-import claude apply to write them");
  });

  it("writes user-scope servers with apply and keeps existing ones", async () => {
    const { host, userFile } = setup({
      claude: { mcpServers: { docs: { type: "http", url: "https://x.test/mcp" }, kept: { command: "new" } } },
      existing: { mcpServers: { kept: { command: "old" } } },
    });

    await host.runCommand("mcp-import", "claude apply");

    expect(readJson(userFile)).toEqual({
      mcpServers: { kept: { command: "old" }, docs: { type: "http", url: "https://x.test/mcp" } },
    });
    expect(host.notices[0].message).toMatch(
      /^pi-mcp-import: \/mcp-import claude apply added 1 server to ~\/\.pi\/agent\/mcp\.json: docs\n/,
    );
    expect(host.notices[0].message).toContain(
      "kept (~/.claude.json (user scope)): already in ~/.pi/agent/mcp.json",
    );
    expect(host.notices[0].message).toContain("run /reload to connect them, then /mcp to check them");
  });

  it("writes project servers to .pi/mcp.json", async () => {
    const { host, projectFile, userFile } = setup({
      mcpJson: { mcpServers: { tool: { command: "tool" } } },
      cursorProject: { mcpServers: { other: { command: "other" } } },
    });

    await host.runCommand("mcp-import", "claude project apply");

    expect(readJson(projectFile)).toEqual({ mcpServers: { tool: { command: "tool" } } });
    expect(existsSync(userFile)).toBe(false);
  });

  it("imports Cursor's project file", async () => {
    const { host, projectFile } = setup({
      cursorProject: { mcpServers: { other: { command: "${userHome}/srv" } } },
    });

    await host.runCommand("mcp-import", "cursor project apply");

    expect(readJson(projectFile)).toEqual({ mcpServers: { other: { command: "~/srv" } } });
  });

  it("refuses to write a project file in an untrusted project", async () => {
    const { host, projectFile } = setup({
      mcpJson: { mcpServers: { tool: { command: "tool" } } },
      projectTrusted: false,
    });

    await host.runCommand("mcp-import", "claude project apply");

    expect(existsSync(projectFile)).toBe(false);
    expect(host.notices).toEqual([
      { message: expect.stringMatching(/trust this project first/), level: "error" },
    ]);
  });

  it("says so when the tool has no servers", async () => {
    const { host } = setup();

    await host.runCommand("mcp-import", "cursor");

    expect(host.notices).toEqual([
      {
        message: "pi-mcp-import: /mcp-import cursor found no MCP servers in ~/.cursor/mcp.json",
        level: "info",
      },
    ]);
  });

  it("leaves an invalid target file alone", async () => {
    const { host, userFile } = setup({
      claude: { mcpServers: { docs: { command: "x" } } },
      existing: { mcpServers: [] },
    });

    await host.runCommand("mcp-import", "claude apply");

    expect(readJson(userFile)).toEqual({ mcpServers: [] });
    expect(host.notices[0].level).toBe("error");
  });

  it("reports bad arguments with the usage", async () => {
    const { host } = setup();

    await host.runCommand("mcp-import", "codex");

    expect(host.notices).toEqual([
      { message: expect.stringMatching(/^pi-mcp-import: unknown tool "codex".*usage: /), level: "error" },
    ]);
  });
});

const ENTER: KeyPress = { name: "enter" };
const ESCAPE: KeyPress = { name: "escape" };
const DOWN: KeyPress = { name: "down" };
const SPACE: KeyPress = { name: "space" };
const NONE: KeyPress = { name: "other", char: "n", raw: "n" };

const GITHUB = { command: "gh", args: ["mcp", "serve"] };
const DOCS = { type: "http", url: "https://docs.test/mcp" };
const LINEAR = { command: "linear-mcp" };

const twoSources = () =>
  setup({
    claude: { mcpServers: { github: GITHUB, docs: DOCS } },
    cursorUser: { mcpServers: { linear: LINEAR } },
  });

const formCount = (host: ReturnType<typeof setup>["host"], count: number) =>
  vi.waitFor(() => {
    expect(host.forms).toHaveLength(count);
  });

const line = (lines: readonly string[], text: string) => lines.find((entry) => entry.includes(text)) ?? "";

describe("/mcp-import without arguments", () => {
  it("offers each source with new servers, then the servers, and writes all of them on Enter", async () => {
    const { host, userFile } = twoSources();

    const running = host.runCommand("mcp-import");
    const source = host.form().render(120);

    expect(source.join("\n")).toContain("Import MCP servers from");
    expect(line(source, "Claude Code · user")).toContain("2 new: github, docs → ~/.pi/agent/mcp.json");
    expect(line(source, "Cursor · user")).toContain("1 new: linear → ~/.pi/agent/mcp.json");
    expect(source.join("\n")).not.toContain("this project");

    host.form().press(ENTER);
    await formCount(host, 2);

    const servers = host.form().render(120);

    expect(servers.join("\n")).toContain("Servers to add to ~/.pi/agent/mcp.json");
    expect(servers.join("\n")).toContain("enter to add");
    expect(line(servers, "github")).toContain("[x]");
    expect(line(servers, "github")).toContain("stdio · gh mcp serve");
    expect(line(servers, "docs")).toContain("[x]");
    expect(line(servers, "docs")).toContain("http · https://docs.test/mcp · needs sign-in");

    host.form().press(ENTER);
    await running;

    expect(readJson(userFile)).toEqual({ mcpServers: { github: GITHUB, docs: DOCS } });
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toMatch(
      /^pi-mcp-import: added 2 servers to ~\/\.pi\/agent\/mcp\.json: github, docs\n/,
    );
    expect(host.notices[0].message).toContain("run /reload to connect them, then /mcp to check them");
  });

  it("writes only the checked servers and lists the others as not selected", async () => {
    const { host, userFile } = twoSources();

    const running = host.runCommand("mcp-import");

    host.form().press(ENTER);
    await formCount(host, 2);
    host.form().press(NONE, DOWN, SPACE, ENTER);
    await running;

    expect(readJson(userFile)).toEqual({ mcpServers: { docs: DOCS } });
    expect(host.notices[0].message).toMatch(
      /^pi-mcp-import: added 1 server to ~\/\.pi\/agent\/mcp\.json: docs\n/,
    );
    expect(host.notices[0].message).toContain("github (~/.claude.json (user scope)): not selected");
  });

  it("imports from the second source when it is picked", async () => {
    const { host, userFile } = twoSources();

    const running = host.runCommand("mcp-import");

    host.form().press(DOWN, ENTER);
    await formCount(host, 2);
    host.form().press(ENTER);
    await running;

    expect(readJson(userFile)).toEqual({ mcpServers: { linear: LINEAR } });
  });

  it("writes nothing and says nothing when the source step is cancelled", async () => {
    const { host, userFile } = twoSources();

    const running = host.runCommand("mcp-import");

    host.form().press(ESCAPE);
    await running;

    expect(host.forms).toHaveLength(1);
    expect(existsSync(userFile)).toBe(false);
    expect(host.notices).toEqual([]);
  });

  it("writes nothing and says nothing when the server step is cancelled", async () => {
    const { host, userFile } = twoSources();

    const running = host.runCommand("mcp-import");

    host.form().press(ENTER);
    await formCount(host, 2);
    host.form().press(SPACE, ESCAPE);
    await running;

    expect(existsSync(userFile)).toBe(false);
    expect(host.notices).toEqual([]);
  });

  it("says so and writes nothing when no server is checked", async () => {
    const { host, userFile } = twoSources();

    const running = host.runCommand("mcp-import");

    host.form().press(ENTER);
    await formCount(host, 2);
    host.form().press(NONE, ENTER);
    await running;

    expect(existsSync(userFile)).toBe(false);
    expect(host.notices).toEqual([
      { message: "pi-mcp-import: nothing selected, nothing written", level: "info" },
    ]);
  });

  it("goes straight to the servers when only one source has new ones", async () => {
    const { host, userFile } = setup({ claude: { mcpServers: { github: GITHUB } } });

    const running = host.runCommand("mcp-import");

    expect(host.form().render(120).join("\n")).toContain("Servers to add to ~/.pi/agent/mcp.json");

    host.form().press(ENTER);
    await running;

    expect(host.forms).toHaveLength(1);
    expect(readJson(userFile)).toEqual({ mcpServers: { github: GITHUB } });
  });

  it("writes project servers to .pi/mcp.json in a trusted project", async () => {
    const { host, projectFile, userFile } = setup({
      mcpJson: { mcpServers: { tool: { command: "tool" } } },
      cursorUser: { mcpServers: { linear: LINEAR } },
    });

    const running = host.runCommand("mcp-import");

    expect(line(host.form().render(120), "Claude Code · this project")).toContain(
      "1 new: tool → .pi/mcp.json",
    );

    host.form().press(ENTER);
    await formCount(host, 2);
    host.form().press(ENTER);
    await running;

    expect(readJson(projectFile)).toEqual({ mcpServers: { tool: { command: "tool" } } });
    expect(existsSync(userFile)).toBe(false);
  });

  it("leaves out project files in an untrusted project", async () => {
    const { host, projectFile } = setup({
      mcpJson: { mcpServers: { tool: { command: "tool" } } },
      cursorUser: { mcpServers: { linear: LINEAR } },
      projectTrusted: false,
    });

    const running = host.runCommand("mcp-import");

    expect(host.form().render(120).join("\n")).toContain("Servers to add to ~/.pi/agent/mcp.json");

    host.form().press(ESCAPE);
    await running;

    expect(existsSync(projectFile)).toBe(false);
  });

  it("asks to trust the project when only its files have servers", async () => {
    const { host, projectFile } = setup({
      mcpJson: { mcpServers: { tool: { command: "tool" } } },
      projectTrusted: false,
    });

    await host.runCommand("mcp-import");

    expect(host.forms).toEqual([]);
    expect(existsSync(projectFile)).toBe(false);
    expect(host.notices).toEqual([
      {
        message:
          "pi-mcp-import: found MCP servers only in this project's files; trust this project first, pi reads .pi/mcp.json only in trusted projects",
        level: "error",
      },
    ]);
  });

  it("lists every file it checked when there is nothing to import", async () => {
    const { host } = setup();

    await host.runCommand("mcp-import");

    expect(host.forms).toEqual([]);
    expect(host.notices).toEqual([
      {
        message:
          "pi-mcp-import: found no MCP servers to import in ~/.claude.json (user scope), ~/.claude.json (local scope of this project), .mcp.json, ~/.cursor/mcp.json, .cursor/mcp.json",
        level: "info",
      },
    ]);
  });

  it("says so when every server is already there", async () => {
    const { host } = setup({
      claude: { mcpServers: { kept: { command: "new" } } },
      existing: { mcpServers: { kept: { command: "old" } } },
    });

    await host.runCommand("mcp-import");

    expect(host.forms).toEqual([]);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toBe(
      "pi-mcp-import: nothing new to import: every server in ~/.claude.json (user scope) is already in ~/.pi/agent/mcp.json",
    );
  });

  it("lists why each found server cannot be added", async () => {
    const { host } = setup({
      claude: { mcpServers: { kept: { command: "new" }, "bad name": { command: "x" } } },
      existing: { mcpServers: { kept: { command: "old" } } },
    });

    await host.runCommand("mcp-import");

    expect(host.forms).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: [
          "pi-mcp-import: nothing to import from ~/.claude.json (user scope)",
          "",
          "skipped:",
          "  kept (~/.claude.json (user scope)): already in ~/.pi/agent/mcp.json, left unchanged",
          "  bad name (~/.claude.json (user scope)): pi server names use only letters, digits, _ and -",
        ].join("\n"),
        level: "info",
      },
    ]);
  });

  it("does not report broken project files in an untrusted project", async () => {
    const { host } = setup({ projectTrusted: false });

    writeFileSync(join(host.session().cwd, ".mcp.json"), "{ broken");

    await host.runCommand("mcp-import");

    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toMatch(/^pi-mcp-import: found no MCP servers to import in /);
    expect(host.notices[0].message).not.toContain(".mcp.json,");
  });

  it("keeps changes made to the target file while the form was open", async () => {
    const { host, userFile } = setup({
      claude: { mcpServers: { github: GITHUB } },
      existing: { mcpServers: {} },
    });

    const running = host.runCommand("mcp-import");

    writeFileSync(userFile, JSON.stringify({ mcpServers: { outside: LINEAR } }));
    host.form().press(ENTER);
    await running;

    expect(readJson(userFile)).toEqual({ mcpServers: { outside: LINEAR, github: GITHUB } });
  });

  it("keeps the usage error outside the interactive terminal", async () => {
    const { host } = setup({ claude: { mcpServers: { github: GITHUB } }, mode: "rpc" });

    await host.runCommand("mcp-import");

    expect(host.forms).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: expect.stringMatching(/^pi-mcp-import: name the tool to import from; usage: /),
        level: "error",
      },
    ]);
  });
});
