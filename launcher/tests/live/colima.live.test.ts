import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

hooks.describe("colima volume ownership", () => {
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

const MASK_CONTAINER = `pi-sandbox-live-mask-${randomBytes(4).toString("hex")}`;

hooks.describe("colima read-only binds on the share", () => {
  const backend = createColimaBackend({
    home: "",
    stateDir: "",
    socketPath: socketPath ?? "",
    runner: createProcessRunner(),
  });
  const state = { dir: "", id: "", work: "" };

  const spec = (work: string, empty: string): LauncherContainerSpec => ({
    name: MASK_CONTAINER,
    image: RUNNABLE,
    labels: { [LABELS.repoHash]: randomBytes(32).toString("hex") },
    mounts: [
      { kind: "bind", source: work, target: work, readOnly: false },
      { kind: "bind", source: empty, target: join(work, "locked"), readOnly: true },
      {
        kind: "bind",
        source: join(work, "repo", ".git", "hooks"),
        target: join(work, "repo", ".git", "hooks"),
        readOnly: true,
      },
      {
        kind: "bind",
        source: join(work, "repo", ".git", "config"),
        target: join(work, "repo", ".git", "config"),
        readOnly: true,
      },
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
    state.work = join(state.dir, "work");

    const empty = join(state.dir, "empty");

    await mkdir(join(state.work, "locked", "repo", ".git"), { recursive: true });
    await mkdir(join(state.work, "repo", ".git", "hooks"), { recursive: true });
    await writeFile(join(state.work, "repo", ".git", "config"), "[core]\n");
    await mkdir(empty);

    await chmod(join(state.work, "locked"), 0o000);

    await backend.pullImage(PULLABLE);

    await buildFrom(backend.buildImage, RUNNABLE, `FROM ${PULLABLE}\nCMD ["sleep", "3600"]\n`);

    state.id = (await ensureContainer({ backend, spec: spec(state.work, empty), stateDir: state.dir })).id;
  }, 300_000);

  hooks.afterAll(async () => {
    if (state.id !== "") {
      await backend.removeContainer(state.id);
    }

    await chmod(join(state.work, "locked"), 0o755).catch(() => undefined);

    await rm(state.dir, { recursive: true, force: true });
  });

  hooks.it(
    "a read-only bind of an empty folder hides a mode-000 folder on the share and stays closed",
    async () => {
      const locked = join(state.work, "locked");

      hooks
        .expect(
          await probe(
            `ls -A ${locked}; chmod 755 ${locked} 2>/dev/null && echo chmod; mkdir ${locked}/x 2>/dev/null && echo mkdir; echo done`,
          ),
        )
        .toEqual({ code: 0, stdout: "done\n", stderr: "" });
    },
  );

  hooks.it(
    "a read-only file or folder bind cannot be written through another letter case of its name",
    async () => {
      const git = join(state.work, "repo", ".git");

      await probe(
        `echo planted >> ${git}/CONFIG 2>/dev/null; mkdir -p ${git}/HOOKS 2>/dev/null; echo planted > ${git}/HOOKS/x 2>/dev/null; true`,
      );

      hooks.expect(await readFile(join(git, "config"), "utf8")).toBe("[core]\n");
      hooks.expect(existsSync(join(git, "hooks", "x"))).toBe(false);
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

hooks.describe("colima sandbox image missing-command hint", () => {
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
        repoHash: "a".repeat(64),
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
