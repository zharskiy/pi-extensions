import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { writeSettingsFile } from "../plugin/settings-files.ts";
import { ensureProjectSubdir, writeProjectFile } from "../project-dir.ts";

const temp = useTempDirs();

const REPOSITORY_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !REPOSITORY_OVERRIDES.includes(key))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const ignoreFile = (cwd: string) => join(cwd, ".pi", ".gitignore");

describe("writeProjectFile", () => {
  it("writes the file under .pi and a .gitignore that ignores everything", () => {
    const cwd = temp.make("pi-project-dir-");

    const path = writeProjectFile(cwd, "mcp.json", "{}\n");

    expect(path).toBe(join(cwd, ".pi", "mcp.json"));
    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(readFileSync(ignoreFile(cwd), "utf8")).toBe("*\n");
  });

  it("creates the folders of a nested path", () => {
    const cwd = temp.make("pi-project-dir-");

    writeProjectFile(cwd, join("agents", "scout.md"), "scout\n");

    expect(readFileSync(join(cwd, ".pi", "agents", "scout.md"), "utf8")).toBe("scout\n");
    expect(readFileSync(ignoreFile(cwd), "utf8")).toBe("*\n");
  });

  it("writes the .gitignore only when it creates .pi", () => {
    const cwd = temp.make("pi-project-dir-");

    writeProjectFile(cwd, "mcp.json", "{}\n");

    rmSync(ignoreFile(cwd));

    writeProjectFile(cwd, "pi-subagents.json", "{}\n");

    expect(existsSync(ignoreFile(cwd))).toBe(false);
  });

  it("leaves an existing .pi without a .gitignore alone", () => {
    const cwd = temp.make("pi-project-dir-");

    mkdirSync(join(cwd, ".pi"));

    writeProjectFile(cwd, "mcp.json", "{}\n");

    expect(readdirSync(join(cwd, ".pi"))).toEqual(["mcp.json"]);
  });

  it("throws when .pi is a file", () => {
    const cwd = temp.make("pi-project-dir-");

    writeFileSync(join(cwd, ".pi"), "");

    expect(() => writeProjectFile(cwd, "mcp.json", "{}\n")).toThrow(/EEXIST/);
  });

  it("keeps a fresh .pi out of git status", () => {
    const cwd = temp.make("pi-project-dir-");

    execFileSync("git", ["init", "-q", cwd], { env });

    writeProjectFile(cwd, "mcp.json", "{}\n");

    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { env, encoding: "utf8" });

    expect(status).toBe("");
  });
});

describe("ensureProjectSubdir", () => {
  it("creates the folder under .pi with the .gitignore and returns its path", () => {
    const cwd = temp.make("pi-project-dir-");

    const dir = ensureProjectSubdir(cwd, "worktrees");

    expect(dir).toBe(join(cwd, ".pi", "worktrees"));
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(readFileSync(ignoreFile(cwd), "utf8")).toBe("*\n");
  });

  it("leaves an existing .pi without a .gitignore alone", () => {
    const cwd = temp.make("pi-project-dir-");

    mkdirSync(join(cwd, ".pi"));

    ensureProjectSubdir(cwd, "worktrees");

    expect(readdirSync(join(cwd, ".pi"))).toEqual(["worktrees"]);
  });
});

describe("writeSettingsFile", () => {
  it("writes a project file through .pi with its .gitignore", () => {
    const cwd = temp.make("pi-project-dir-");
    const agentDir = temp.make("pi-agent-dir-");

    const path = writeSettingsFile({ agentDir, cwd }, "project", "mcp.json", "{}\n");

    expect(path).toBe(join(cwd, ".pi", "mcp.json"));
    expect(readFileSync(ignoreFile(cwd), "utf8")).toBe("*\n");
  });

  it("writes a user file to the agent dir and leaves the project alone", () => {
    const cwd = temp.make("pi-project-dir-");
    const agentDir = join(temp.make("pi-agent-dir-"), "agent");

    const path = writeSettingsFile({ agentDir, cwd }, "user", "mcp.json", "{}\n");

    expect(readFileSync(path, "utf8")).toBe("{}\n");
    expect(path).toBe(join(agentDir, "mcp.json"));
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });
});
