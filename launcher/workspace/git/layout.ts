import { dirname, join, resolve } from "node:path";
import { lstatOrUndefined, readRegularFile, realOrResolved } from "../../shared/index.ts";

interface GitLayout {
  gitDir: string;
  gitCommonDir: string;
}

const OWN_COMMONDIR = /^\.\n?$/;

const GIT_FILE_PREFIX = "gitdir: ";

const pointerPath = (base: string, text: string) => resolve(base, text.trimEnd());

const gitFileTarget = (base: string, text: string) => {
  const [line = ""] = text.split("\n");

  return line.startsWith(GIT_FILE_PREFIX) ? pointerPath(base, line.slice(GIT_FILE_PREFIX.length)) : undefined;
};

const readQuietly = (path: string) =>
  readRegularFile(path).then(
    (file) => file.data.toString("utf8"),
    () => undefined,
  );

export const findGitRoot = async (dir: string): Promise<string | undefined> => {
  if ((await lstatOrUndefined(join(dir, ".git"))) !== undefined) {
    return dir;
  }

  const parent = dirname(dir);

  return parent === dir ? undefined : findGitRoot(parent);
};

export const gitLayoutOf = async (repoRoot: string): Promise<GitLayout> => {
  const dotGit = join(repoRoot, ".git");
  const text = await readQuietly(dotGit);
  const gitDir = (text === undefined ? undefined : gitFileTarget(repoRoot, text)) ?? dotGit;
  const pointer = await readQuietly(join(gitDir, "commondir"));

  if (pointer === undefined || pointer === "" || OWN_COMMONDIR.test(pointer)) {
    return { gitDir, gitCommonDir: gitDir };
  }

  return { gitDir, gitCommonDir: pointerPath(await realOrResolved(gitDir), pointer) };
};
