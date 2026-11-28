import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type ExecIo, type ExecSpec, roleOf } from "../../backend/index.ts";
import {
  listLauncherContainers,
  ROOT_EXEC_ENV,
  removeLaunchContainer,
  startLaunchContainer,
} from "../../container/lifecycle.ts";
import { buildContainerSpec, type ContainerSpecInput } from "../../container/spec.ts";
import { GUEST_PATHS, LauncherError } from "../../shared/index.ts";
import { createFakeBackend, FAKE_INSTALL } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "pinata-lifecycle-work-")));

mkdirSync(join(WORK, "repo"));

mkdirSync(join(WORK, "other"));

const workspace = {
  cwd: `${WORK}/repo/src`,
  repoRoot: `${WORK}/repo`,
  gitCommonDir: `${WORK}/repo/.git`,
  isGitRepo: true,
};

const LOCK_STATE = mkdtempSync(join(tmpdir(), "pinata-lifecycle-lock-"));

afterAll(() => {
  rmSync(LOCK_STATE, { recursive: true, force: true });

  rmSync(WORK, { recursive: true, force: true });
});

const READY_MARKER = GUEST_PATHS.ready;

const launches = { count: 0 };

const nextLaunchId = () => {
  launches.count += 1;

  return launches.count.toString(16).padStart(16, "0");
};

const specOf = (overrides: Partial<ContainerSpecInput> = {}) =>
  buildContainerSpec({
    workspace,
    config: sandboxConfig(),
    image: { digest: "sha256:one", id: "sha256:image-one" },
    stateDir: LOCK_STATE,
    launchId: nextLaunchId(),
    workspaceRoot: workspace.repoRoot,
    proxy: {
      url: "http://pinata:t@pinata-proxy:3128",
      network: { kind: "internal", name: "pinata" },
    },
    servicePorts: [],
    renderDir: join(LOCK_STATE, "render"),
    hostSessions: { off: "sessions.host is off", notice: false },
    toolEnv: {},
    binds: [],
    ...overrides,
  });

const withVolumes = (...volumes: string[]) => specOf({ config: sandboxConfig({ mounts: { volumes } }) });

describe("startLaunchContainer", () => {
  it("creates and starts the launch's container with its volumes", async () => {
    const fake = createFakeBackend();
    const spec = withVolumes("~/.npm");
    const result = await startLaunchContainer({ backend: fake.backend, spec });

    expect(fake.containers.get(result.id)?.summary.state).toBe("running");
    expect(fake.containers.get(result.id)?.summary.name).toBe(spec.name);
    expect([...fake.volumes].sort()).toEqual(
      spec.mounts
        .filter((mount) => mount.kind === "volume")
        .map((mount) => mount.source)
        .sort(),
    );
  });

  it("gives two launches of one repository their own containers on the same volumes", async () => {
    const fake = createFakeBackend();
    const [one, two] = await Promise.all([
      startLaunchContainer({ backend: fake.backend, spec: withVolumes("~/.npm") }),
      startLaunchContainer({ backend: fake.backend, spec: withVolumes("~/.npm") }),
    ]);
    const volumesOf = (id: string) =>
      fake.containers
        .get(id)
        ?.spec?.mounts.filter((mount) => mount.kind === "volume")
        .map((mount) => mount.source);

    expect(one.id).not.toBe(two.id);
    expect(fake.containers.size).toBe(2);
    expect(volumesOf(one.id)).toEqual(volumesOf(two.id));
  });

  it("applies a changed config to the next launch and leaves the running one alone", async () => {
    const fake = createFakeBackend();
    const first = await startLaunchContainer({ backend: fake.backend, spec: specOf() });
    const second = await startLaunchContainer({
      backend: fake.backend,
      spec: specOf({
        image: { digest: "sha256:two", id: "sha256:image-two" },
      }),
    });

    expect(second.id).not.toBe(first.id);
    expect(fake.containers.get(first.id)?.summary.state).toBe("running");
    expect(fake.containers.get(second.id)?.spec?.image).toBe("sha256:image-two");
    expect(fake.stops).toEqual([]);
  });

  it("creates no folder in the repository on the host", async () => {
    const fake = createFakeBackend();

    await startLaunchContainer({ backend: fake.backend, spec: withVolumes("~/.npm", "/opt/data") });

    expect(await readdir(workspace.repoRoot)).toEqual([]);
  });

  it("creates the container from the spec it is given", async () => {
    const fake = createFakeBackend();
    const ready = specOf();
    const result = await startLaunchContainer({ backend: fake.backend, spec: ready });

    expect(result.spec).toBe(ready);
    expect(fake.containers.get(result.id)?.summary.name).toBe(ready.name);
  });
});

describe("removeLaunchContainer", () => {
  it("stops and removes only the container of its own launch", async () => {
    const fake = createFakeBackend();
    const spec = specOf();
    const mine = await startLaunchContainer({ backend: fake.backend, spec });
    const other = await startLaunchContainer({ backend: fake.backend, spec: specOf() });

    const removed = await removeLaunchContainer(fake.backend, spec.labels["pinata.launch-id"] ?? "");

    expect(removed.map((container) => container.id)).toEqual([mine.id]);
    expect([...fake.containers.keys()]).toEqual([other.id]);
  });

  it("never takes a pod or a service for the launch's container", async () => {
    const fake = createFakeBackend();
    const launch = { "pinata.managed": "true", "pinata.launch-id": "launch-1" };
    const pod = fake.addContainer({
      name: "pod",
      labels: { ...launch, "pinata.role": "pod" },
      state: "running",
      image: "pod",
    });
    const service = fake.addContainer({
      name: "service",
      labels: { ...launch, "pinata.role": "service" },
      state: "running",
      image: "service",
    });

    expect(await removeLaunchContainer(fake.backend, "launch-1")).toEqual([]);
    expect([...fake.containers.keys()]).toEqual([pod, service]);
  });
});

describe("container housekeeping", () => {
  it("lists only launcher containers", async () => {
    const fake = createFakeBackend();
    const { id } = await startLaunchContainer({ backend: fake.backend, spec: specOf() });

    fake.addContainer({ name: "unrelated", labels: {}, state: "running", image: "busybox" });

    expect((await listLauncherContainers(fake.backend)).map((container) => container.id)).toEqual([id]);
  });

  it("lists a relay among the launcher's containers", async () => {
    const fake = createFakeBackend();

    await fake.backend.prepareRelay({
      hostPort: 3128,
      imageId: "relay",
      preamble: "PINATA test",
    });

    expect((await listLauncherContainers(fake.backend)).map((container) => roleOf(container.labels))).toEqual(
      ["relay"],
    );
  });
});

describe("volumes the sandbox writes", () => {
  const cachedSpec = () =>
    specOf({
      config: sandboxConfig({
        mounts: { volumes: ["~/.cache/pip", { target: "/opt/data" }] },
      }),
    });
  const stopper: { backend?: ReturnType<typeof createFakeBackend>["backend"] } = {};
  const answering =
    (match: string, answer: { code?: number; stderr?: string; error?: string }) =>
    (spec: ExecSpec, io: ExecIo) => {
      if (spec.command[2]?.includes(match) !== true) {
        return undefined;
      }

      if (answer.error !== undefined) {
        throw new Error(answer.error);
      }

      io.stderr.write(answer.stderr ?? "");

      return answer.code ?? 0;
    };
  const exitingOn = (match: string) => async (spec: ExecSpec) => {
    if (spec.command[2]?.includes(match) !== true) {
      return undefined;
    }

    await stopper.backend?.stopContainer(spec.containerId);

    throw new Error(
      `engine: POST /containers/${spec.containerId}/exec failed (409): container is not running`,
    );
  };
  const chownsOf = (fake: ReturnType<typeof createFakeBackend>) =>
    fake.execs
      .filter((exec) => exec.spec.command[2]?.startsWith("/bin/chown ") === true)
      .map((exec) => exec.spec);

  it("runs every root exec through /bin/sh and calls its programs by absolute path", async () => {
    const fake = createFakeBackend();
    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    const rootExecs = fake.execs.filter((exec) => exec.spec.user === "0").map((exec) => exec.spec.command);

    expect(rootExecs).not.toHaveLength(0);
    expect(rootExecs.map((command) => [command[0], command[2]?.split(" ")[0]])).toEqual(
      rootExecs.map(() => ["/bin/sh", "/bin/chown"]),
    );
  });

  it("overrides the loader and libc variables the container's environment would pass to every root exec", async () => {
    const fake = createFakeBackend();
    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    const rootEnvs = fake.execs.filter((exec) => exec.spec.user === "0").map((exec) => exec.spec.env);

    expect(rootEnvs).not.toHaveLength(0);
    expect(rootEnvs).toEqual(rootEnvs.map(() => ROOT_EXEC_ENV));
    expect(ROOT_EXEC_ENV).toMatchObject({
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LD_PRELOAD: "",
      LD_LIBRARY_PATH: "",
      LD_AUDIT: "",
      GCONV_PATH: "",
      GLIBC_TUNABLES: "",
    });
    expect(Object.keys(ROOT_EXEC_ENV)).toHaveLength(22);
  });

  it("hands every owned volume and the home dirs above a shared cache to the sandbox user as root on each start", async () => {
    const fake = createFakeBackend();
    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    const [chown] = chownsOf(fake);

    expect(chownsOf(fake)).toHaveLength(2);
    expect(chown?.user).toBe("0");
    expect(chown?.command).toEqual([
      "/bin/sh",
      "-c",
      '/bin/chown -h 1000:1000 "$@" && : > /tmp/pinata-handover',
      "sh",
      "/home/pi/.cache",
      "/home/pi/.cache/pip",
      "/opt/data",
    ]);
  });

  it("stops the launch when the hand-over the entrypoint waits for fails", async () => {
    const fake = createFakeBackend({ exec: answering("chown", { code: 1, stderr: "denied\n" }) });

    await expect(startLaunchContainer({ backend: fake.backend, spec: cachedSpec() })).rejects.toThrow(
      "the sandbox could not hand its volumes to the sandbox user: denied",
    );
  });

  it("stops the launch when the hand-over of volumes outside the home fails", async () => {
    const fake = createFakeBackend({ exec: answering("chown", { code: 1, stderr: "denied\n" }) });

    await expect(
      startLaunchContainer({ backend: fake.backend, spec: withVolumes("/opt/data") }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("the sandbox could not hand its volumes to the sandbox user: denied"),
    });
  });

  it("stops the launch when the engine rejects the hand-over", async () => {
    const fake = createFakeBackend({ exec: answering("chown", { error: "engine: exec refused" }) });

    await expect(
      startLaunchContainer({ backend: fake.backend, spec: withVolumes("/opt/data") }),
    ).rejects.toThrow("engine: exec refused");
  });

  it("names a container that exited during startup instead of the engine's bare not-running error", async () => {
    const fake = createFakeBackend({ exec: exitingOn("chown") });

    stopper.backend = fake.backend;

    await expect(startLaunchContainer({ backend: fake.backend, spec: cachedSpec() })).rejects.toThrow(
      /^the sandbox container exited during startup, before pi could run \(engine: POST .* failed \(409\)/,
    );
  });

  it("keeps the hint of the failed step when the container exited during startup", async () => {
    const fake = createFakeBackend();
    const failing = (pinnedImage: boolean) =>
      startLaunchContainer({
        backend: fake.backend,
        spec: cachedSpec(),
        afterCreate: async (id) => {
          await fake.backend.stopContainer(id);

          throw new LauncherError("the session dir is not shared", "the share hint");
        },
        pinnedImage,
      }).catch((error: unknown) => error);

    expect(await failing(false)).toMatchObject({
      message:
        "the sandbox container exited during startup, before pi could run (the session dir is not shared)",
      hint: "the share hint",
    });
    expect(await failing(true)).toMatchObject({
      hint: "the share hint; the image is pinned by image.reference and may predate this pinata version",
    });
  });

  it("falls back to the doctor hint when the failed step had none", async () => {
    const fake = createFakeBackend({ exec: exitingOn(READY_MARKER) });

    stopper.backend = fake.backend;

    await expect(startLaunchContainer({ backend: fake.backend, spec: cachedSpec() })).rejects.toMatchObject({
      message: expect.stringMatching(/^the sandbox container exited during startup/),
      hint: "run pinata doctor",
    });
  });

  it("tells the entrypoint to wait for the handover whenever the sandbox owns a volume", () => {
    expect(cachedSpec().env.PINATA_AWAIT_HANDOVER).toBe("1");
    expect(withVolumes("/opt/data").env.PINATA_AWAIT_HANDOVER).toBe("1");
    expect(specOf().env.PINATA_AWAIT_HANDOVER).toBeUndefined();
  });

  it("runs no root exec when the sandbox has no volumes of its own to hand over", async () => {
    const fake = createFakeBackend();

    await startLaunchContainer({
      backend: fake.backend,
      spec: specOf(),
    });

    expect(chownsOf(fake)).toEqual([]);
  });

  it("labels configured volumes with the install only", async () => {
    const fake = createFakeBackend();
    const spec = cachedSpec();

    await startLaunchContainer({ backend: fake.backend, spec });

    const labelsOf = (target: string) =>
      fake.volumeLabels.get(spec.mounts.find((mount) => mount.target === target)?.source ?? "");

    expect(labelsOf("/home/pi/.cache/pip")).toEqual({
      "pinata.managed": "true",
      "pinata.install": FAKE_INSTALL,
    });
    expect(labelsOf("/opt/data")).toEqual({
      "pinata.managed": "true",
      "pinata.install": FAKE_INSTALL,
    });
  });
});

describe("waiting for the entrypoint", () => {
  const readyExecsOf = (fake: ReturnType<typeof createFakeBackend>) =>
    fake.execs
      .filter((exec) => exec.spec.command[2]?.includes(READY_MARKER) === true)
      .map((exec) => exec.spec);

  const readyScript = async () => {
    const fake = createFakeBackend();

    await startLaunchContainer({ backend: fake.backend, spec: specOf() });

    return readyExecsOf(fake)[0]?.command[2] ?? "";
  };

  const runReadyScript = (script: string, entrypoint: string, marker: string, tries: number) => {
    const local = script
      .replaceAll(READY_MARKER, "@marker@")
      .replaceAll(GUEST_PATHS.entrypoint, entrypoint)
      .replaceAll("@marker@", marker)
      .replace(/-lt \d+/, `-lt ${tries}`);

    return new Promise<number | null>((resolve) => {
      spawn("sh", ["-c", local]).on("close", resolve);
    });
  };

  it("waits as the sandbox user, after the hand-over and before the steps that use the home", async () => {
    const fake = createFakeBackend();
    const seen: string[] = [];

    await startLaunchContainer({
      backend: fake.backend,
      spec: specOf({ config: sandboxConfig({ mounts: { volumes: ["~/.m2/repository"] } }) }),
      afterCreate: async () => {
        seen.push(...fake.execs.map((exec) => (exec.spec.command[2] ?? "").split(" ")[0] ?? ""));
      },
    });

    const [ready] = readyExecsOf(fake);

    expect(seen).toEqual(["/bin/chown", "grep"]);
    expect(ready?.user).toBeUndefined();
  });

  it("waits on every launch, also without volumes to hand over", async () => {
    const fake = createFakeBackend();

    await startLaunchContainer({ backend: fake.backend, spec: specOf() });

    expect(readyExecsOf(fake)).toHaveLength(1);
  });

  it("stops the launch with what it waited for when the entrypoint never finishes", async () => {
    const fake = createFakeBackend({
      exec: (spec) => (spec.command[2]?.includes(READY_MARKER) === true ? 3 : undefined),
    });

    await expect(startLaunchContainer({ backend: fake.backend, spec: specOf() })).rejects.toThrow(
      "the sandbox entrypoint did not finish preparing the home within 60 s (no /tmp/pinata-ready)",
    );
  });

  it("fails the launch and names the port when the forwarder could not listen", async () => {
    const fake = createFakeBackend({
      exec: (spec, io) => {
        if (spec.command[2]?.includes(READY_MARKER) !== true) {
          return undefined;
        }

        io.stderr.write("port 5432 on 127.0.0.1: listen EADDRINUSE: address already in use\n");

        return 4;
      },
    });

    await expect(startLaunchContainer({ backend: fake.backend, spec: specOf() })).rejects.toThrow(
      "the sandbox could not forward the services' ports: port 5432 on 127.0.0.1: listen EADDRINUSE",
    );
  });

  it("reports the forwarder's failure once the home is ready, and passes on an empty forwarder status", async () => {
    const script = await readyScript();
    const dir = mkdtempSync(join(tmpdir(), "pi-ready-forward-"));
    const entrypoint = join(dir, "entrypoint");
    const marker = join(dir, "ready");
    const status = join(dir, "forward");

    await writeFile(entrypoint, `#!/bin/sh\n: > "${marker}"\n`);

    await writeFile(marker, "");

    const local = script.replaceAll(GUEST_PATHS.forwardStatus, status);

    await writeFile(status, "");

    expect(await runReadyScript(local, entrypoint, marker, 600)).toBe(0);

    await writeFile(status, "port 5432 on ::1: listen EADDRINUSE\n");

    expect(await runReadyScript(local, entrypoint, marker, 600)).toBe(4);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns at once for an image whose entrypoint writes no ready marker, and waits for one that does", async () => {
    const script = await readyScript();
    const dir = mkdtempSync(join(tmpdir(), "pi-ready-wait-"));
    const marker = join(dir, "ready");
    const oldEntrypoint = join(dir, "old-entrypoint");
    const newEntrypoint = join(dir, "new-entrypoint");

    await writeFile(oldEntrypoint, "#!/bin/sh\nexec sleep infinity\n");

    await writeFile(newEntrypoint, `#!/bin/sh\n: > "${marker}"\n`);

    const started = Date.now();

    expect(await runReadyScript(script, oldEntrypoint, marker, 600)).toBe(0);
    expect(await runReadyScript(script, join(dir, "missing"), marker, 600)).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await runReadyScript(script, newEntrypoint, marker, 3)).toBe(3);

    const waiting = runReadyScript(script, newEntrypoint, marker, 600);

    await writeFile(marker, "");

    expect(await waiting).toBe(0);

    rmSync(dir, { recursive: true, force: true });
  });
});
