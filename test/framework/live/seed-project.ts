import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { errorText } from "../../../platform/shared/index.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

const GIT = "/usr/bin/git";

const FIXED_IDENTITY = [
  "-c",
  "user.name=live",
  "-c",
  "user.email=live@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

export const repoGit = (args: string[]) =>
  execFileSync(GIT, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const seedStep = (command: string, args: string[], sha: string, cwd = repoRoot) => {
  try {
    execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    throw new Error(`seeding the live project from ${sha} failed: ${errorText(error)}`);
  }
};

export const seedProjectFromCommit = (project: string, sha: string) => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-seed-"));
  const archive = join(scratch, "seed.tar");

  try {
    seedStep(GIT, ["archive", "--format=tar", "--output", archive, sha], sha);
    seedStep("/usr/bin/tar", ["-xf", archive, "-C", project], sha);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  seedStep(GIT, [...FIXED_IDENTITY, "init", "-q"], sha, project);
  seedStep(GIT, [...FIXED_IDENTITY, "add", "-A"], sha, project);
  seedStep(GIT, [...FIXED_IDENTITY, "commit", "-q", "--no-verify", "-m", "seed"], sha, project);

  if (existsSync(join(repoRoot, "node_modules"))) {
    symlinkSync(join(repoRoot, "node_modules"), join(project, "node_modules"));
    appendFileSync(join(project, ".git", "info", "exclude"), "node_modules\n");
  }
};

export const applyCommitDiff = (project: string, sha: string) => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-patch-"));
  const patch = join(scratch, "change.patch");

  try {
    writeFileSync(
      patch,
      repoGit(["diff-tree", "-p", "--binary", "--no-color", "--no-ext-diff", `${sha}^`, sha]),
    );
    execFileSync(GIT, ["apply", patch], { cwd: project, stdio: ["ignore", "ignore", "pipe"] });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

export type ExactEdit = { file: string; from: string; to: string };

export const replaceExactlyOnce = (project: string, edit: ExactEdit) => {
  const path = join(project, edit.file);
  const text = readFileSync(path, "utf8");
  const at = text.indexOf(edit.from);

  if (at < 0 || text.indexOf(edit.from, at + 1) >= 0) {
    throw new Error(`the plant for ${edit.file} must match exactly once`);
  }

  writeFileSync(path, text.replace(edit.from, edit.to));

  return text.slice(0, at).split("\n").length;
};
