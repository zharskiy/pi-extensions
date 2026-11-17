import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import { createProcessRunner } from "../../shared/index.ts";
import { discoverWorkspace, type Workspace, workspaceFolder } from "../../workspace/index.ts";

const IDENTITY = [
  "-c",
  "user.name=test",
  "-c",
  "user.email=test@example.com",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "advice.addEmbeddedRepo=false",
];

const gitHome = mkdtempSync(join(tmpdir(), "pi-sandbox-git-home-"));

afterAll(() => {
  rmSync(gitHome, { recursive: true, force: true });
});

const inherited = Object.entries(process.env).filter(
  (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_"),
);

const gitEnv: Record<string, string> = {
  ...Object.fromEntries(inherited),
  HOME: gitHome,
  XDG_CONFIG_HOME: join(gitHome, ".config"),
  GIT_CONFIG_NOSYSTEM: "1",
};

export const gitRunner = createProcessRunner({ baseEnv: gitEnv });

export const git = async (cwd: string, args: string[]) => {
  const result = await gitRunner.run("git", [...IDENTITY, ...args], { cwd });

  expect(result.code, result.stderr).toBe(0);
};

export const createGitRepo = async (path: string) => {
  await mkdir(path, { recursive: true });

  await git(path, ["init", "--quiet"]);

  await git(path, ["commit", "--quiet", "--allow-empty", "-m", "init"]);

  return path;
};

export const discoverAt = async (
  cwd: string,
  ...rest: Parameters<typeof discoverWorkspace> extends [unknown, ...infer R] ? R : never
) => discoverWorkspace(await workspaceFolder(cwd), ...rest);

export const workspaceAt = (repoRoot: string, gitCommonDir?: string): Workspace => ({
  cwd: repoRoot,
  repoRoot,
  gitCommonDir,
  isGitRepo: gitCommonDir !== undefined,
});
