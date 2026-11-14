import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tempDir } from "../support/temp-dir.ts";

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};

export const createConfigFile = async () => {
  const root = await tempDir("config");
  const userFile = join(root, "user", "config.json");

  return {
    userFile,
    env: {
      PI_SANDBOX_USER_CONFIG: userFile,
      PI_SANDBOX_STATE_DIR: join(root, "state"),
    },
    write: (value: unknown) => writeJson(userFile, value),
  };
};
