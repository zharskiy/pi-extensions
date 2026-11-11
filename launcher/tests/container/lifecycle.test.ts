import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  type LaunchContainerInput,
  listLauncherContainers,
  removeLaunchContainer,
  removeRepoContainers,
  startLaunchContainer as startWith,
} from "../../container/lifecycle.ts";
import { buildContainerSpec, type ContainerSpecInput } from "../../container/spec.ts";
import { readCreatedDirs, sha256Hex } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-lifecycle-work-")));

mkdirSync(join(WORK, "repo"));

mkdirSync(join(WORK, "other"));

const workspace = {
  cwd: `${WORK}/repo/src`,
  repoRoot: `${WORK}/repo`,
  gitCommonDir: `${WORK}/repo/.git`,
  isGitRepo: true,
};

const LOCK_STATE = mkdtempSync(join(tmpdir(), "pi-sandbox-lifecycle-lock-"));

afterAll(() => {
  rmSync(LOCK_STATE, { recursive: true, force: true });

  rmSync(WORK, { recursive: true, force: true });
});

const REPO_HASH = sha256Hex(`${WORK}/repo`);

const launches = { count: 0 };

const nextLaunchId = () => {
  launches.count += 1;

  return launches.count.toString(16).padStart(16, "0");
};

const startLaunchContainer = (input: Omit<LaunchContainerInput, "stateDir">) =>
  startWith({ stateDir: LOCK_STATE, ...input });

const specOf = (overrides: Partial<ContainerSpecInput> = {}) =>
  buildContainerSpec({
    workspace,
    config: sandboxConfig(),
    image: { reference: "pi-sandbox:local", digest: "sha256:one", id: "sha256:image-one" },
    hostUid: 501,
    stateDir: LOCK_STATE,
    launchId: nextLaunchId(),
    gitOverlay: { selfBinds: [], readOnlyDirs: [] },
    proxy: {
      url: "http://pi-sandbox:t@pi-sandbox-proxy:3128",
      network: { kind: "internal", name: "pi-sandbox" },
    },
    trust: { pemPath: "/state/ca/trust.pem", hash: "trust-1" },
    ...overrides,
  });

const overlaid = (...paths: string[]) =>
  specOf({ workspace: { ...workspace, overlays: paths.map((path) => join(WORK, "repo", path)) } });

describe("startLaunchContainer", () => {
  it("creates and starts the launch's container with its volumes", async () => {
    const fake = createFakeBackend();
    const spec = overlaid("node_modules");
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
      startLaunchContainer({ backend: fake.backend, spec: overlaid("node_modules") }),
      startLaunchContainer({ backend: fake.backend, spec: overlaid("node_modules") }),
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
        image: { reference: "pi-sandbox:local", digest: "sha256:two", id: "sha256:image-two" },
      }),
    });

    expect(second.id).not.toBe(first.id);
    expect(fake.containers.get(first.id)?.summary.state).toBe("running");
    expect(fake.containers.get(second.id)?.spec?.image).toBe("sha256:image-two");
    expect(fake.stops).toEqual([]);
  });

  it("creates from the spec the step right before the start returns, under the container lock", async () => {
    const fake = createFakeBackend();
    const order: string[] = [];
    const ready = specOf();
    const result = await startLaunchContainer({
      backend: fake.backend,
      spec: specOf(),
      beforeStart: async () => {
        order.push("before");

        return ready;
      },
      afterCreate: async () => {
        order.push("after");
      },
    });

    expect(order).toEqual(["before", "after"]);
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

    const removed = await removeLaunchContainer(fake.backend, spec.labels["pi-sandbox.launch-id"] ?? "");

    expect(removed.map((container) => container.id)).toEqual([mine.id]);
    expect([...fake.containers.keys()]).toEqual([other.id]);
  });
});

describe("container housekeeping", () => {
  it("lists only launcher containers", async () => {
    const fake = createFakeBackend();
    const { id } = await startLaunchContainer({ backend: fake.backend, spec: specOf() });

    fake.addContainer({ name: "unrelated", labels: {}, state: "running", image: "busybox" });

    expect((await listLauncherContainers(fake.backend)).map((container) => container.id)).toEqual([id]);
  });

  it("stops the container of one repository with a short timeout, then removes it", async () => {
    const fake = createFakeBackend();
    const { id } = await startLaunchContainer({ backend: fake.backend, spec: specOf() });

    const removed = await removeRepoContainers(fake.backend, REPO_HASH);

    expect(removed.map((container) => container.id)).toEqual([id]);
    expect(fake.stops).toEqual([{ id, timeoutSeconds: 3 }]);
    expect(fake.removals).toEqual([id]);
    expect(fake.containers.size).toBe(0);
  });

  it("never lists a relay as a launcher container", async () => {
    const fake = createFakeBackend();

    await fake.backend.prepareProxyRoute({ hostPort: 3128, repoHash: REPO_HASH, imageId: "relay" });

    expect(await listLauncherContainers(fake.backend)).toEqual([]);
    expect(await removeRepoContainers(fake.backend, REPO_HASH)).toEqual([]);
  });
});

describe("volumes the sandbox writes", () => {
  const project = join(WORK, "repo", "web");
  const nodeWorkspace = { ...workspace, overlays: [join(project, "node_modules")] };
  const cachedSpec = (stateDir = LOCK_STATE) =>
    specOf({
      workspace: nodeWorkspace,
      stateDir,
      config: sandboxConfig({ mounts: { sharedCaches: ["~/.cache/pip"] } }),
    });
  const chownsOf = (fake: ReturnType<typeof createFakeBackend>) =>
    fake.execs.filter((exec) => exec.spec.command[0] === "chown").map((exec) => exec.spec);

  beforeEach(async () => {
    await rm(project, { recursive: true, force: true });

    await mkdir(project, { recursive: true });
  });

  it("creates a missing mount point on the host before the container starts and records it", async () => {
    const fake = createFakeBackend();

    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    expect((await stat(join(project, "node_modules"))).isDirectory()).toBe(true);
    expect(await readCreatedDirs(LOCK_STATE, REPO_HASH)).toContain(join(project, "node_modules"));
  });

  it("removes overlay volumes of this repository that no container mounts any more", async () => {
    const fake = createFakeBackend();

    await fake.backend.ensureVolume("pi-sandbox-cache-stale", {
      "pi-sandbox.repo-hash": REPO_HASH,
      "pi-sandbox.cache-path": "gone/node_modules",
    });

    await fake.backend.ensureVolume("pi-sandbox-cache-foreign", {
      "pi-sandbox.repo-hash": "f".repeat(64),
      "pi-sandbox.cache-path": "gone/node_modules",
    });

    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    expect(fake.volumes.has("pi-sandbox-cache-stale")).toBe(false);
    expect(fake.volumes.has("pi-sandbox-cache-foreign")).toBe(true);
  });

  it("refuses a mount point the sandbox side turned into a link", async () => {
    const fake = createFakeBackend();
    const elsewhere = join(WORK, "elsewhere");

    await mkdir(elsewhere, { recursive: true });

    await symlink(elsewhere, join(project, "node_modules"));

    await expect(startLaunchContainer({ backend: fake.backend, spec: cachedSpec() })).rejects.toThrow(
      `the mount point ${join(project, "node_modules")} is a symbolic link`,
    );
    expect([...fake.containers.values()]).toEqual([]);
  });

  it("refuses a mount point whose existing parent leads outside the repository through a link", async () => {
    const fake = createFakeBackend();
    const outside = join(WORK, "outside");
    const link = join(WORK, "repo", "sym");

    await rm(link, { force: true });

    await mkdir(join(outside, "x"), { recursive: true });

    await symlink(outside, link);

    const spec = overlaid("sym/x/y");

    await expect(startLaunchContainer({ backend: fake.backend, spec })).rejects.toThrow(
      `the mount point ${join(link, "x")} leads outside ${workspace.repoRoot}`,
    );
    expect(await stat(join(outside, "x", "y")).catch(() => undefined)).toBeUndefined();
    expect([...fake.containers.values()]).toEqual([]);

    await rm(link, { force: true });
  });

  it("creates no mount point inside the git dir through a path that resolves into it", async () => {
    const fake = createFakeBackend();
    const hooks = join(WORK, "repo", ".git", "hooks");
    const alias = join(WORK, "repo", "git-alias");

    await mkdir(hooks, { recursive: true });

    await rm(alias, { force: true });

    await symlink(join(WORK, "repo", ".git"), alias);

    const spec = overlaid("git-alias/hooks/pre-commit");

    await expect(startLaunchContainer({ backend: fake.backend, spec })).rejects.toThrow(
      `the mount point ${join(alias, "hooks")} lies inside ${join(WORK, "repo", ".git")}, which the sandbox protects`,
    );
    expect(await stat(join(hooks, "pre-commit")).catch(() => undefined)).toBeUndefined();
    expect([...fake.containers.values()]).toEqual([]);

    await rm(alias, { force: true });
  });

  it("never creates a hook through a differently spelled git dir, whatever the filesystem's case rules", async () => {
    const fake = createFakeBackend();
    const hooks = join(WORK, "repo", ".git", "hooks");

    await mkdir(hooks, { recursive: true });

    const spec = overlaid(".GIT/hooks/pre-commit");

    await startLaunchContainer({ backend: fake.backend, spec }).catch(() => undefined);

    expect(await stat(join(hooks, "pre-commit")).catch(() => undefined)).toBeUndefined();

    await rm(join(WORK, "repo", ".GIT"), { recursive: true, force: true }).catch(() => undefined);
  });

  it("passes on the notice for a build output overlay left out inside a protected path", async () => {
    const fake = createFakeBackend();
    const guardedDir = join(WORK, "repo", ".githooks");
    const spec = specOf({
      workspace: { ...workspace, overlays: [join(guardedDir, "node_modules")] },
      gitOverlay: { selfBinds: [], readOnlyDirs: [guardedDir] },
    });
    const ensured = await startLaunchContainer({ backend: fake.backend, spec });

    expect(ensured.notices).toContain(
      `${join(guardedDir, "node_modules")} is not overlaid: it lies inside ${guardedDir}, which the sandbox protects`,
    );
    expect(await stat(join(guardedDir, "node_modules")).catch(() => undefined)).toBeUndefined();
  });

  it("creates every missing directory of a nested mount point inside the repository", async () => {
    const fake = createFakeBackend();
    const spec = overlaid("deep/a/b");

    await startLaunchContainer({ backend: fake.backend, spec });

    expect((await stat(join(WORK, "repo", "deep", "a", "b"))).isDirectory()).toBe(true);
  });

  it("hands every owned volume and the home dirs above a shared cache to the sandbox user as root on each start", async () => {
    const fake = createFakeBackend();
    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    await startLaunchContainer({ backend: fake.backend, spec: cachedSpec() });

    const [chown] = chownsOf(fake);

    expect(chownsOf(fake)).toHaveLength(2);
    expect(chown?.user).toBe("0");
    expect(chown?.command).toEqual([
      "chown",
      "-h",
      "1000:1000",
      "/home/pi/.cache",
      join(project, "node_modules"),
      "/home/pi/.cache/pip",
    ]);
  });

  it("warns when handing the volumes to the sandbox user fails", async () => {
    const fake = createFakeBackend({ execScripts: [{ command: ["chown"], code: 1, stderr: "denied\n" }] });
    const result = await startLaunchContainer({
      backend: fake.backend,
      spec: specOf({ workspace: nodeWorkspace }),
    });

    expect(result.notices).toEqual([
      "warning: the sandbox user may not be able to write its cache volumes: denied",
    ]);
  });

  it("runs no root exec when the sandbox has no volumes of its own to hand over", async () => {
    const fake = createFakeBackend();

    await startLaunchContainer({
      backend: fake.backend,
      spec: specOf(),
    });

    expect(chownsOf(fake)).toEqual([]);
  });

  it("labels repository volumes with the repository and shared caches with the user only", async () => {
    const fake = createFakeBackend();
    const spec = cachedSpec();

    await startLaunchContainer({ backend: fake.backend, spec });

    const labelsOf = (target: string) =>
      fake.volumeLabels.get(spec.mounts.find((mount) => mount.target === target)?.source ?? "");

    expect(labelsOf(join(project, "node_modules"))).toEqual({
      "pi-sandbox.managed": "true",
      "pi-sandbox.repo-hash": sha256Hex(workspace.repoRoot),
      "pi-sandbox.repo-root": workspace.repoRoot,
      "pi-sandbox.cache-path": "web/node_modules",
    });
    expect(labelsOf("/home/pi/.cache/pip")).toEqual({
      "pi-sandbox.managed": "true",
      "pi-sandbox.user-hash": sha256Hex(LOCK_STATE).slice(0, 12),
      "pi-sandbox.shared-path": "~/.cache/pip",
    });
  });
});
