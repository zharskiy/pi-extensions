import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export const ensureProjectDir = (cwd: string) => {
  const dir = join(cwd, ".pi");
  const created = mkdirSync(dir, { recursive: true }) !== undefined;

  if (created) {
    ignoreFromGit(dir);
  }
};
