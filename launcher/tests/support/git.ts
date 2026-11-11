import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";
import { createProcessRunner } from "../../shared/index.ts";

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
