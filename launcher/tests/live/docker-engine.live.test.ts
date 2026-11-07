import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerEngineBackend, resolveDockerSocket } from "../../backend/index.ts";
import { createProcessRunner } from "../../shared/index.ts";
import { runBackendConformance } from "../backend/conformance.ts";
import { listNetworks, removeNetwork } from "./harness/engine.ts";

const PULLABLE = "busybox:1.36";

const RUNNABLE = "pi-sandbox-conformance:busybox";

const RELAY = "pi-sandbox-relay-test:alpine";

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

const buildFrom = async (
  build: (contextDir: string, tag: string) => Promise<unknown>,
  tag: string,
  dockerfile: string,
) => {
  const context = await mkdtemp(join(tmpdir(), "pi-sandbox-live-"));

  await writeFile(join(context, "Dockerfile"), dockerfile);

  await build(context, tag);

  await rm(context, { recursive: true, force: true });
};

runBackendConformance(
  `docker-engine (${socketPath ?? "no socket"})`,
  hooks,
  async () => {
    const runner = createProcessRunner();
    const backend = createDockerEngineBackend({ socketPath: socketPath ?? "", runner, home: homedir() });

    await backend.pullImage(PULLABLE);

    await buildFrom(backend.buildImage, RUNNABLE, `FROM ${PULLABLE}\nCMD ["sleep", "3600"]\n`);

    await buildFrom(backend.buildImage, RELAY, "FROM alpine:3.20\nRUN apk add --no-cache socat\n");

    return {
      backend,
      pullableImage: PULLABLE,
      runnableImage: RUNNABLE,
      relayImage: RELAY,
      networks: {
        has: async (name) => (await listNetworks()).some((network) => network.Name === name),
        remove: async (name) => {
          await removeNetwork(name);
        },
      },
    };
  },
  { sharedRuntime: true },
);
