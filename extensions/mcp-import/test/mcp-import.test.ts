import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { createMcpImport } from "../src/mcp-import.ts";

const roots: string[] = [];

type Setup = {
  claude?: unknown;
  mcpJson?: unknown;
  cursorProject?: unknown;
  existing?: unknown;
  projectTrusted?: boolean;
};

const setup = ({ claude, mcpJson, cursorProject, existing, projectTrusted = true }: Setup = {}) => {
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

  if (cursorProject !== undefined) {
    writeFileSync(join(cwd, ".cursor", "mcp.json"), JSON.stringify(cursorProject));
  }

  if (existing !== undefined) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(existing));
  }

  const host = createFakeHost({ agentDir, cwd, projectTrusted });

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
