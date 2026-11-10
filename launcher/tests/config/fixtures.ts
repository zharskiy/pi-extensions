import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tempDir } from "../support/temp-dir.ts";

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};

export const createLayers = async () => {
  const root = await tempDir("config");
  const repoRoot = join(root, "repo");
  const policyFile = join(root, "policy.json");
  const userFile = join(root, "user", "config.json");
  const projectFile = join(repoRoot, ".pi", "sandbox.json");

  await mkdir(repoRoot, { recursive: true });

  return {
    repoRoot,
    policyFile,
    userFile,
    projectFile,
    env: {
      PI_SANDBOX_POLICY_FILE: policyFile,
      PI_SANDBOX_USER_CONFIG: userFile,
      PI_SANDBOX_STATE_DIR: join(root, "state"),
    },
    policy: (value: unknown) => writeJson(policyFile, value),
    user: (value: unknown) => writeJson(userFile, value),
    project: (value: unknown) => writeJson(projectFile, value),
  };
};
