import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDockerEngineBackend, execCapture, LABELS, resolveDockerSocket } from "../../backend/index.ts";
import { ensureContainer, type LauncherContainerSpec } from "../../container/index.ts";
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

const OWNERSHIP_VOLUME = `pi-sandbox-live-ownership-${randomBytes(4).toString("hex")}`;

const OWNERSHIP_TARGET = "/home/pi/.cache/live";

hooks.describe("docker-engine volume ownership", () => {
  const backend = createDockerEngineBackend({
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
    home: homedir(),
  });
  const state = { dir: "", id: "" };

  hooks.afterAll(async () => {
    if (state.id !== "") {
      await backend.removeContainer(state.id);
    }

    await backend.removeVolume(OWNERSHIP_VOLUME);

    await rm(state.dir, { recursive: true, force: true });
  });

  const spec = (): LauncherContainerSpec => ({
    name: OWNERSHIP_VOLUME,
    image: RUNNABLE,
    labels: { [LABELS.repoHash]: randomBytes(32).toString("hex") },
    mounts: [{ kind: "volume", source: OWNERSHIP_VOLUME, target: OWNERSHIP_TARGET, readOnly: false }],
    network: { kind: "none" },
    env: {},
    workdir: "/",
    user: "1000:1000",
    readOnlyRoot: true,
    tmpfs: ["/tmp:mode=1777", "/home/pi:mode=1777"],
    init: true,
    resources: { cpus: 1, memoryGiB: 0.25 },
    requiredCopies: [],
    copiesDir: join(state.dir, "copies"),
    volumeLabels: {},
    ownedPaths: ["/home/pi/.cache", OWNERSHIP_TARGET],
  });

  hooks.it(
    "a cache volume mounted at a path absent from the image is writable by the sandbox user",
    async () => {
      state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-live-ownership-"));

      await backend.pullImage(PULLABLE);

      await buildFrom(backend.buildImage, RUNNABLE, `FROM ${PULLABLE}\nCMD ["sleep", "3600"]\n`);

      const ensured = await ensureContainer({ backend, spec: spec() });

      state.id = ensured.id;

      const written = await execCapture(backend, {
        containerId: ensured.id,
        command: ["sh", "-c", `touch ${OWNERSHIP_TARGET}/probe /home/pi/.cache/beside && id -u`],
        env: {},
        workdir: "/",
      });

      hooks.expect(ensured.notices).toEqual([]);
      hooks.expect(written).toEqual({ code: 0, stdout: "1000\n", stderr: "" });
    },
  );
});
