import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PROJECT_DIR = ".pi";

const PROJECT_IGNORE = "*\n";

const isAlreadyThere = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

const ignoreFromGit = (dir: string) => {
  try {
    writeFileSync(join(dir, ".gitignore"), PROJECT_IGNORE, { flag: "wx" });
  } catch (error) {
    if (!isAlreadyThere(error)) {
      throw error;
    }
  }
};

const ensureProjectDir = (cwd: string) => {
  const dir = projectPath(cwd);
  const created = mkdirSync(dir, { recursive: true }) !== undefined;

  if (created) {
    ignoreFromGit(dir);
  }
};

export const projectPath = (cwd: string, relativePath = "") => join(cwd, PROJECT_DIR, relativePath);

export const ensureProjectSubdir = (cwd: string, relativePath: string) => {
  const dir = projectPath(cwd, relativePath);

  ensureProjectDir(cwd);

  mkdirSync(dir, { recursive: true });

  return dir;
};

export const writeProjectFile = (cwd: string, relativePath: string, text: string) => {
  const path = projectPath(cwd, relativePath);

  ensureProjectSubdir(cwd, dirname(relativePath));

  writeFileSync(path, text);

  return path;
};
