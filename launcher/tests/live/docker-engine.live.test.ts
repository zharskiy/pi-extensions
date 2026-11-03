import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerEngineBackend, resolveDockerSocket } from "../../backend/index.ts";
import { createProcessRunner } from "../../shared/index.ts";
import { runBackendConformance } from "../backend/conformance.ts";

const PULLABLE = "busybox:1.36";

const RUNNABLE = "pi-sandbox-conformance:busybox";

const colimaSockets = () => {
  const root = join(homedir(), ".colima");

  return existsSync(root) ? readdirSync(root).map((profile) => join(root, profile, "docker.sock")) : [];
};

const candidates = () => [
  resolveDockerSocket({ env: process.env, home: homedir() }),
  ...colimaSockets(),
  "/var/run/docker.sock",
  join(homedir(), ".docker", "run", "docker.sock"),
];

const socketPath = candidates().find((path) => existsSync(path));

const enabled = process.env.PI_SANDBOX_LIVE === "1" && socketPath !== undefined;

const hooks = enabled
  ? { describe, it, expect, beforeAll, afterAll }
  : { describe: describe.skip, it, expect, beforeAll, afterAll };

runBackendConformance(`docker-engine (${socketPath ?? "no socket"})`, hooks, async () => {
  const runner = createProcessRunner();
  const backend = createDockerEngineBackend({ socketPath: socketPath ?? "", runner, home: homedir() });
  const context = await mkdtemp(join(tmpdir(), "pi-sandbox-live-"));

  await backend.pullImage(PULLABLE);

  await writeFile(join(context, "Dockerfile"), `FROM ${PULLABLE}\nCMD ["sleep", "3600"]\n`);

  await backend.buildImage(context, RUNNABLE);

  await rm(context, { recursive: true, force: true });

  return { backend, pullableImage: PULLABLE, runnableImage: RUNNABLE };
});
