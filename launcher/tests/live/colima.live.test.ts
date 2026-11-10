import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createColimaBackend, execCapture, LABELS } from "../../backend/index.ts";
import {
  type LauncherContainerSpec,
  removeLaunchContainer,
  startLaunchContainer,
} from "../../container/index.ts";
import { ensureSandboxImage } from "../../image/index.ts";
import { createProcessRunner, launcherRoot } from "../../shared/index.ts";
import { runBackendConformance } from "../backend/conformance.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { listNetworks, removeNetwork } from "./harness/engine.ts";

const PULLABLE = "busybox:1.36";

const RUNNABLE = "pi-sandbox-conformance:busybox";

const RELAY = "pi-sandbox-relay-test:alpine";

const socketPath = [join(homedir(), ".colima", "pi-sandbox", "docker.sock")].find((path) => existsSync(path));

const enabled = process.env.PI_SANDBOX_LIVE === "1" && socketPath !== undefined;

const hooks = enabled
  ? { describe, it, expect, beforeAll, afterAll }
  : { describe: describe.skip, it, expect, beforeAll, afterAll };

const launchLabels = (launchId: string) => ({
  [LABELS.repoHash]: randomBytes(32).toString("hex"),
  [LABELS.launchId]: launchId,
});

const newLaunch = () => randomBytes(8).toString("hex");

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
  `colima (${socketPath ?? "no socket"})`,
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

const SANDBOX_USER = "1000:1000";

hooks.describe("colima volume ownership", () => {
  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
  });
  const state = { dir: "", launchId: newLaunch() };

  hooks.afterAll(async () => {
    await removeLaunchContainer(backend, state.launchId);

    await backend.removeVolume(OWNERSHIP_VOLUME);

    await rm(state.dir, { recursive: true, force: true });
  });

  const spec = (): LauncherContainerSpec => ({
    name: OWNERSHIP_VOLUME,
    image: RUNNABLE,
    labels: launchLabels(state.launchId),
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

      const ensured = await startLaunchContainer({ backend, spec: spec(), stateDir: state.dir });

      const written = await execCapture(backend, {
        containerId: ensured.id,
        command: ["sh", "-c", `touch ${OWNERSHIP_TARGET}/probe /home/pi/.cache/beside && id -u`],
        env: {},
        workdir: "/",
        user: SANDBOX_USER,
      });

      hooks.expect(ensured.notices).toEqual([]);
      hooks.expect(written).toEqual({ code: 0, stdout: "1000\n", stderr: "" });
    },
  );
});

const BINDS_CONTAINER = `pi-sandbox-live-binds-${randomBytes(4).toString("hex")}`;

hooks.describe("colima read-only binds on the share", () => {
  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
  });
  const state = { dir: "", id: "", git: "", launchId: newLaunch() };

  const spec = (work: string, git: string): LauncherContainerSpec => ({
    name: BINDS_CONTAINER,
    image: RUNNABLE,
    labels: launchLabels(state.launchId),
    mounts: [
      { kind: "bind", source: work, target: work, readOnly: false },
      { kind: "bind", source: join(git, "hooks"), target: join(git, "hooks"), readOnly: true },
    ],
    network: { kind: "none" },
    env: {},
    workdir: "/",
    readOnlyRoot: true,
    tmpfs: ["/tmp:mode=1777"],
    init: true,
    resources: { cpus: 1, memoryGiB: 0.25 },
    volumeLabels: {},
    ownedPaths: [],
  });

  const probe = (script: string) =>
    execCapture(backend, { containerId: state.id, command: ["sh", "-c", script], env: {}, workdir: "/" });

  hooks.beforeAll(async () => {
    const root = join(homedir(), ".cache", "pi-sandbox-live");

    await mkdir(root, { recursive: true });

    state.dir = await mkdtemp(join(root, "binds-"));

    const work = join(state.dir, "work");

    state.git = join(work, "repo", ".git");

    await mkdir(join(state.git, "hooks"), { recursive: true });
    await writeFile(join(state.git, "config"), "[core]\n");

    await backend.pullImage(PULLABLE);

    await buildFrom(backend.buildImage, RUNNABLE, `FROM ${PULLABLE}\nCMD ["sleep", "3600"]\n`);

    state.id = (await startLaunchContainer({ backend, spec: spec(work, state.git), stateDir: state.dir })).id;
  }, 300_000);

  hooks.afterAll(async () => {
    await removeLaunchContainer(backend, state.launchId);

    await rm(state.dir, { recursive: true, force: true });
  });

  hooks.it(
    "a read-only folder bind refuses a write under its own name and under another letter case",
    async () => {
      const written = await probe(
        `for name in hooks HOOKS; do (echo planted > ${state.git}/$name/x) 2>&1; done; true`,
      );

      hooks.expect(written.stdout.match(/Read-only file system/g)).toHaveLength(2);
      hooks.expect(existsSync(join(state.git, "hooks", "x"))).toBe(false);
    },
  );

  hooks.it("the rest of the git dir stays writable through the folder's own bind", async () => {
    hooks.expect(await probe(`printf '[user]\\n' >> ${state.git}/config`)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    hooks.expect(await readFile(join(state.git, "config"), "utf8")).toBe("[core]\n[user]\n");
  });
});

const HINT_CONTAINER = `pi-sandbox-live-bash-hint-${randomBytes(4).toString("hex")}`;

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

hooks.describe("colima sandbox image missing-command hint", () => {
  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
  });
  const state = { dir: "", launchId: newLaunch() };

  hooks.afterAll(async () => {
    await removeLaunchContainer(backend, state.launchId);

    await rm(state.dir, { recursive: true, force: true });
  });

  const spec = (image: string): LauncherContainerSpec => ({
    name: HINT_CONTAINER,
    image,
    labels: launchLabels(state.launchId),
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

      const image = await ensureSandboxImage({
        backend,
        config: sandboxConfig(),
        stateDir: state.dir,
        versions: async () => ({ pi: await pinnedPi() }),
      });

      const ensured = await startLaunchContainer({ backend, spec: spec(image.id), stateDir: state.dir });

      const probed = await execCapture(backend, {
        containerId: ensured.id,
        command: ["node", "-e", SHELL_TOOL_PROBE],
        env: {},
        workdir: "/home/pi",
      });

      hooks.expect(probed.code).toBe(0);
      hooks.expect(JSON.parse(probed.stdout)).toEqual({
        stderr:
          "bash: pi-sandbox-missing-tool: command not found\npi-sandbox: pi-sandbox-missing-tool is not in the sandbox image; add its Debian package to image.packages or its npm package to image.npmGlobal in ~/.config/pi-sandbox/config.json on the host\n",
        status: 127,
      });
    },
  );
});
