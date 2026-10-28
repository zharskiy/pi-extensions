import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { ensureProjectDir } from "../project-dir.ts";

const temp = useTempDirs();

const REPOSITORY_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !REPOSITORY_OVERRIDES.includes(key))),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const ignoreFile = (cwd: string) => join(cwd, ".pi", ".gitignore");

describe("ensureProjectDir", () => {
  it("creates .pi with a .gitignore that ignores everything", () => {
    const cwd = temp.make("pi-project-dir-");

    ensureProjectDir(cwd);

    expect(readFileSync(ignoreFile(cwd), "utf8")).toBe("*\n");
  });

  it("leaves an existing .pi without a .gitignore alone", () => {
    const cwd = temp.make("pi-project-dir-");

    mkdirSync(join(cwd, ".pi"));

    ensureProjectDir(cwd);

    expect(existsSync(ignoreFile(cwd))).toBe(false);
  });

  it("keeps a fresh .pi out of git status", () => {
    const cwd = temp.make("pi-project-dir-");

    execFileSync("git", ["init", "-q", cwd], { env });

    ensureProjectDir(cwd);

    writeFileSync(join(cwd, ".pi", "mcp.json"), "{}\n");

    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { env, encoding: "utf8" });

    expect(status).toBe("");
  });
});
