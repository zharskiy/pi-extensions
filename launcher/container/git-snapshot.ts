import { mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lstatOrUndefined, readRegularFile, repoHash, sha256Hex, stateLayout } from "../shared/index.ts";
import { gitRefusal } from "../workspace/index.ts";

export interface GitSnapshotTargets {
  readOnlyDirs: string[];
  readOnlyFiles: string[];
}

const MODE_BITS = 0o777;

const SNAPSHOT_NAME_LENGTH = 16;

export const gitSnapshotsDir = (stateDir: string, repoRoot: string) =>
  stateLayout(stateDir).repo(repoHash(repoRoot)).gitSnapshots;

export const gitSnapshotPath = (snapshotsDir: string, target: string) =>
  join(snapshotsDir, sha256Hex(target).slice(0, SNAPSHOT_NAME_LENGTH));

const copyRegular = async (source: string, destination: string) => {
  const { data, mode } = await readRegularFile(source);

  await writeFile(destination, data, { mode: mode & MODE_BITS, flag: "wx" });
};

const copyTree = async (source: string, destination: string): Promise<void> => {
  await mkdir(destination);

  const info = await lstatOrUndefined(source);

  if (info === undefined || !info.isDirectory()) {
    return;
  }

  const entries = await readdir(source, { withFileTypes: true });

  await Promise.all(
    entries.map((entry) => {
      const from = join(source, entry.name);
      const to = join(destination, entry.name);

      if (entry.isSymbolicLink()) {
        throw gitRefusal(from, "is a symbolic link; symlinked hooks are not supported inside the sandbox");
      }

      if (entry.isFile()) {
        return copyRegular(from, to);
      }

      return entry.isDirectory() ? copyTree(from, to) : Promise.resolve();
    }),
  );
};

const assertReal = async (target: string) => {
  const real = await realpath(target).catch(() => target);

  if (real !== target) {
    throw gitRefusal(target, "goes through a symbolic link");
  }
};

const copyLeaf = async (target: string, destination: string) => {
  await assertReal(target);

  await copyRegular(target, destination);
};

const copyDirLeaf = async (target: string, destination: string) => {
  await assertReal(target);

  await copyTree(target, destination);
};

export const writeGitSnapshots = async (targets: GitSnapshotTargets, snapshotsDir: string) => {
  await rm(snapshotsDir, { recursive: true, force: true });

  await mkdir(snapshotsDir, { recursive: true });

  await Promise.all([
    ...targets.readOnlyFiles.map((target) => copyLeaf(target, gitSnapshotPath(snapshotsDir, target))),
    ...targets.readOnlyDirs.map((target) => copyDirLeaf(target, gitSnapshotPath(snapshotsDir, target))),
  ]);
};
