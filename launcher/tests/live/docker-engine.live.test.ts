import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createColimaBackend, engineSocketPath, execCapture, LABELS } from "../../backend/index.ts";
import { ensureContainer, type LauncherContainerSpec } from "../../container/index.ts";
import { ensureSandboxImage } from "../../image/index.ts";
import { createProcessRunner, launcherRoot } from "../../shared/index.ts";
import { runBackendConformance } from "../backend/conformance.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { listNetworks, removeNetwork } from "./harness/engine.ts";

const PULLABLE = "busybox:1.36";

const RUNNABLE = "pi-sandbox-conformance:busybox";

const RELAY = "pi-sandbox-relay-test:alpine";

const socketPath = [engineSocketPath(homedir())].find((path) => existsSync(path));

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
    const backend = createColimaBackend({ home: "", stateDir: "", socketPath: socketPath ?? "", runner });

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
  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
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
    readOnlyRoot: true,
    tmpfs: ["/tmp:mode=1777", "/home/pi:mode=1777"],
    init: true,
    resources: { cpus: 1, memoryGiB: 0.25 },
    volumeLabels: {},
    ownedPaths: ["/home/pi/.cache", OWNERSHIP_TARGET],
  });

  hooks.it(
    "a cache volume mounted at a path absent from the image is writable by the sandbox user",
    async () => {
      state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-live-ownership-"));

      await backend.pullImage(PULLABLE);

      await buildFrom(backend.buildImage, RUNNABLE, `FROM ${PULLABLE}\nCMD ["sleep", "3600"]\n`);

      const ensured = await ensureContainer({ backend, spec: spec(), stateDir: state.dir });

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

const HINT_CONTAINER = `pi-sandbox-live-bash-hint-${randomBytes(4).toString("hex")}`;

const HINT_IMAGE = "pi-sandbox-live-bash-hint:test";

const pinnedPi = async () => {
  const manifest = JSON.parse(await readFile(join(launcherRoot(), "..", "package.json"), "utf8")) as {
    devDependencies: Record<string, string>;
  };

  return (manifest.devDependencies["@earendil-works/pi-coding-agent"] ?? "").replace(/^[^0-9]*/, "");
};

const SHELL_TOOL_PROBE = [
  'const { spawnSync } = require("node:child_process");',
  'const result = spawnSync("bash", ["-c", "pi-sandbox-missing-tool --version"], {',
  '  encoding: "utf8",',
  '  stdio: ["pipe", "pipe", "pipe"],',
  "  env: { PATH: process.env.PATH, BASH_ENV: process.env.BASH_ENV },",
  "});",
  "process.stdout.write(JSON.stringify({ stderr: result.stderr, status: result.status }));",
].join("\n");

hooks.describe("docker-engine sandbox image missing-command hint", () => {
  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
  });
  const state = { dir: "", id: "" };

  hooks.afterAll(async () => {
    if (state.id !== "") {
      await backend.removeContainer(state.id);
    }

    await rm(state.dir, { recursive: true, force: true });
  });

  const spec = (): LauncherContainerSpec => ({
    name: HINT_CONTAINER,
    image: HINT_IMAGE,
    labels: { [LABELS.repoHash]: randomBytes(32).toString("hex") },
    mounts: [],
    network: { kind: "none" },
    env: {},
    workdir: "/home/pi",
    readOnlyRoot: true,
    tmpfs: ["/tmp:mode=1777", "/home/pi:mode=1777"],
    init: true,
    resources: { cpus: 1, memoryGiB: 0.5 },
    volumeLabels: {},
    ownedPaths: [],
  });

  hooks.it(
    "a bash -c spawned like pi's shell tool, with socket stdin and no SHLVL, prints the hint and exits 127",
    async () => {
      state.dir = await mkdtemp(join(tmpdir(), "pi-sandbox-live-bash-hint-"));

      await ensureSandboxImage({
        backend,
        config: sandboxConfig({ image: { reference: HINT_IMAGE } }),
        stateDir: state.dir,
        versions: async () => ({ pi: await pinnedPi(), extensions: { kind: "none" } }),
        inUse: async () => false,
      });

      const ensured = await ensureContainer({ backend, spec: spec(), stateDir: state.dir });

      state.id = ensured.id;

      const probed = await execCapture(backend, {
        containerId: ensured.id,
        command: ["node", "-e", SHELL_TOOL_PROBE],
        env: {},
        workdir: "/home/pi",
      });

      hooks.expect(probed.code).toBe(0);
      hooks.expect(JSON.parse(probed.stdout)).toEqual({
        stderr:
          "bash: pi-sandbox-missing-tool: command not found\npi-sandbox: pi-sandbox-missing-tool is not in the sandbox image; add it with image.packages or image.npmGlobal in ~/.config/pi-sandbox/config.json (see pi sandbox doctor)\n",
        status: 127,
      });
    },
  );
});
