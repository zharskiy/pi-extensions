import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });

  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
};

export const createLayers = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const repoRoot = join(root, "repo");
  const policyFile = join(root, "policy.json");
  const userFile = join(root, "user", "config.json");
  const projectFile = join(repoRoot, ".pi", "sandbox.json");

  created.push(root);

  await mkdir(repoRoot, { recursive: true });

  return {
    repoRoot,
    policyFile,
    userFile,
    projectFile,
    env: { PI_SANDBOX_POLICY_FILE: policyFile, PI_SANDBOX_USER_CONFIG: userFile },
    policy: (value: unknown) => writeJson(policyFile, value),
    user: (value: unknown) => writeJson(userFile, value),
    project: (value: unknown) => writeJson(projectFile, value),
  };
};
