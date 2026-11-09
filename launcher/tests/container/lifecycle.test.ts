import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EnsureContainerInput,
  ensureContainer as ensureWith,
  findCurrentContainer,
  gitDirInUseElsewhere,
  listLauncherContainers,
  removeRepoContainers,
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

const stateDirs: string[] = [];

const LOCK_STATE = mkdtempSync(join(tmpdir(), "pi-sandbox-lifecycle-lock-"));

afterAll(() => {
  rmSync(LOCK_STATE, { recursive: true, force: true });

  rmSync(WORK, { recursive: true, force: true });
});

const REPO_HASH = sha256Hex(`${WORK}/repo`);

const ensureContainer = (input: Omit<EnsureContainerInput, "stateDir">) =>
  ensureWith({ stateDir: LOCK_STATE, ...input });

const specOf = (overrides: Partial<ContainerSpecInput> = {}) =>
  buildContainerSpec({
    workspace,
    config: sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: ["node_modules"] } }),
    image: { reference: "pi-sandbox:local", digest: "sha256:one", id: "sha256:image-one" },
    hostEnv: { USER: "dev" },
    hostUid: 501,
    stateDir: LOCK_STATE,
    gitOverlay: { selfBinds: [], readOnlyDirs: [], readOnlyFiles: [] },
    launcherVersion: "0.4.0",
    ...overrides,
  });

const newStateDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sandbox-lifecycle-"));

  stateDirs.push(dir);

  return dir;
};

afterEach(async () => {
  await Promise.all(stateDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ensureContainer", () => {
  const state = { dir: "" };

  beforeEach(async () => {
    state.dir = await newStateDir();
  });

  it("creates and starts a container with its volumes when none exists", async () => {
    const fake = createFakeBackend();
    const result = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(result.created).toBe(true);
    expect(fake.containers.get(result.id)?.summary.state).toBe("running");
    expect([...fake.volumes].sort()).toEqual(
      specOf()
        .mounts.filter((mount) => mount.kind === "volume")
        .map((mount) => mount.source)
        .sort(),
    );
  });

  it("reuses a running container whose image digest and config hash match", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const second = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(second).toMatchObject({ id: first.id, created: false, outdated: false });
    expect(fake.containers.size).toBe(1);
  });

  it("creates a fresh container once the previous one stopped and the engine removed it", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });

    await fake.backend.stopContainer(first.id);

    const second = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(second).toMatchObject({ created: true, outdated: false });
    expect(second.id).not.toBe(first.id);
  });

  it("treats a container made for another proxy token as outdated", async () => {
    const fake = createFakeBackend();
    const network = { kind: "internal" as const, name: "pi-sandbox-net" };
    const first = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ proxy: { url: "http://pi-sandbox:a@pi-sandbox-proxy:3128", network, tokenHash: "a" } }),
    });
    const kept = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ proxy: { url: "http://pi-sandbox:a@pi-sandbox-proxy:3128", network, tokenHash: "b" } }),
      othersLive: async () => true,
    });

    expect(fake.containers.get(first.id)?.summary.labels["pi-sandbox.proxy-token-hash"]).toBe("a");
    expect(kept).toMatchObject({ id: first.id, outdated: true });
  });

  it("replaces the container when the image digest changes", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const updated = specOf({
      image: { reference: "pi-sandbox:local", digest: "sha256:two", id: "sha256:image-two" },
    });
    const second = await ensureContainer({ backend: fake.backend, spec: updated });

    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect([...fake.containers.keys()]).toEqual([second.id]);
  });

  it("replaces the container when the spec changes under the same digest and config hash", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const rerouted = specOf({
      proxy: {
        url: "http://pi-sandbox:t@10.89.0.9:3128",
        network: { kind: "internal", name: "pi-sandbox" },
        tokenHash: "t",
      },
    });
    const second = await ensureContainer({ backend: fake.backend, spec: rerouted });

    expect(second.created).toBe(true);
    expect(fake.containers.has(first.id)).toBe(false);
    expect(fake.containers.get(second.id)?.spec?.env.HTTPS_PROXY).toBe("http://pi-sandbox:t@10.89.0.9:3128");
  });

  it("replaces the container when its spec changes", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const second = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ launcherVersion: "0.5.0" }),
    });

    expect(second.created).toBe(true);
    expect(fake.containers.has(first.id)).toBe(false);
  });

  it("keeps the running container of a changed config while other sessions of the repo are live", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const second = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ launcherVersion: "0.5.0" }),
      othersLive: async () => true,
    });

    expect(second).toMatchObject({ id: first.id, created: false, outdated: true });
    expect(fake.stops).toEqual([]);
    expect([...fake.containers.keys()]).toEqual([first.id]);
  });

  it("replaces the container of a changed config once no other session is live", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const second = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ launcherVersion: "0.5.0" }),
      othersLive: async () => false,
    });

    expect(second.created).toBe(true);
    expect(second.outdated).toBe(false);
    expect(fake.containers.has(first.id)).toBe(false);
  });

  it("creates one container when two first launches of a repo run at once", async () => {
    const fake = createFakeBackend();
    const [one, two] = await Promise.all([
      ensureContainer({ backend: fake.backend, spec: specOf() }),
      ensureContainer({ backend: fake.backend, spec: specOf() }),
    ]);

    expect(one.id).toBe(two.id);
    expect([one.created, two.created].sort()).toEqual([false, true]);
    expect(fake.containers.size).toBe(1);
  });

  it("discards only its own new container when its check after the create fails, never one another launch then adopts", async () => {
    const fake = createFakeBackend();
    const other: { launch?: ReturnType<typeof ensureContainer> } = {};
    const failing = ensureContainer({
      backend: fake.backend,
      spec: specOf(),
      afterCreate: async () => {
        other.launch = ensureContainer({ backend: fake.backend, spec: specOf() });

        await new Promise((resolve) => setTimeout(resolve, 50));

        throw new Error("sessions dir is not shared");
      },
    });

    await expect(failing).rejects.toThrow("sessions dir is not shared");

    const adopted = await other.launch;

    expect(adopted?.created).toBe(true);
    expect([...fake.containers.keys()]).toEqual([adopted?.id]);
    expect(fake.containers.get(adopted?.id ?? "")?.summary.state).toBe("running");
  });

  it("reuses the container another launcher created under the same name", async () => {
    const fake = createFakeBackend();
    const spec = specOf();
    const raced = { id: "" };
    const backend = {
      ...fake.backend,
      createContainer: async () => {
        raced.id = fake.addContainer({ name: spec.name, labels: spec.labels, state: "running", image: "x" });

        throw new Error(`container name ${spec.name} is already in use`);
      },
    };
    const result = await ensureContainer({ backend, spec });

    expect(result).toMatchObject({ id: raced.id, created: false, outdated: false });
    expect(fake.containers.get(raced.id)?.summary.state).toBe("running");
  });
});

describe("ensureContainer and the repository network", () => {
  it("replaces an outdated container without tearing down the network the new one joins", async () => {
    const fake = createFakeBackend();
    const route = await fake.backend.prepareProxyRoute({
      hostPort: 3128,
      repoHash: REPO_HASH,
      imageId: "sha256:image-one",
    });
    const routed = (launcherVersion: string) =>
      specOf({
        launcherVersion,
        proxy: { url: `http://pi-sandbox:t@${route.address}`, network: route.network, tokenHash: "t" },
      });
    const first = await ensureContainer({ backend: fake.backend, spec: routed("0.4.0") });
    const spec = routed("0.5.0");
    const second = await ensureContainer({ backend: fake.backend, spec });

    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(fake.containers.get(second.id)?.summary.state).toBe("running");
    expect(spec.network.kind === "internal" && fake.networks.has(spec.network.name)).toBe(true);
  });
});

describe("container housekeeping", () => {
  it("lists only launcher containers", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    fake.addContainer({ name: "unrelated", labels: {}, state: "running", image: "busybox" });

    expect((await listLauncherContainers(fake.backend)).map((container) => container.id)).toEqual([id]);
  });

  it("stops the container of one repository with a short timeout, waits for the engine to remove it, then deletes it", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    const removed = await removeRepoContainers(fake.backend, REPO_HASH);

    expect(removed.map((container) => container.id)).toEqual([id]);
    expect(fake.stops).toEqual([{ id, timeoutSeconds: 3 }]);
    expect(fake.waits).toEqual([id]);
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

describe("findCurrentContainer", () => {
  it("finds the repository's container only for the same image digest", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect((await findCurrentContainer(fake.backend, workspace, "sha256:one"))?.id).toBe(id);
    expect(await findCurrentContainer(fake.backend, workspace, "sha256:two")).toBeUndefined();
  });
});

describe("gitDirInUseElsewhere", () => {
  it("finds a running sandbox of another checkout that shares or holds this git dir", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const worktree = {
      cwd: `${WORK}/wt`,
      repoRoot: `${WORK}/wt`,
      gitCommonDir: `${WORK}/repo/.git`,
      isGitRepo: true,
    };
    const submodule = {
      cwd: `${WORK}/repo/lib`,
      repoRoot: `${WORK}/repo/lib`,
      gitCommonDir: `${WORK}/repo/.git/modules/lib`,
      isGitRepo: true,
    };
    const unrelated = {
      cwd: `${WORK}/other`,
      repoRoot: `${WORK}/other`,
      gitCommonDir: `${WORK}/other/.git`,
      isGitRepo: true,
    };

    const inUse = (owner: { repoRoot: string; gitCommonDir: string }) =>
      gitDirInUseElsewhere(fake.backend, sha256Hex(owner.repoRoot), owner.gitCommonDir);

    expect(await inUse(worktree)).toBe(true);
    expect(await inUse(submodule)).toBe(true);
    expect(await inUse(unrelated)).toBe(false);
    expect(await inUse(workspace)).toBe(false);

    await fake.backend.stopContainer(id);

    expect(await inUse(worktree)).toBe(false);
  });
});

describe("gitDirInUseElsewhere in a workspace", () => {
  const folder = {
    cwd: WORK,
    repoRoot: WORK,
    isGitRepo: false,
    nested: [{ ...workspace, cwd: workspace.repoRoot }],
  };

  it("keeps a nested repository pinned while its own sandbox runs, and the reverse", async () => {
    const fake = createFakeBackend();
    const single = await ensureContainer({ backend: fake.backend, spec: specOf() });

    const folderHash = sha256Hex(folder.repoRoot);

    expect(await gitDirInUseElsewhere(fake.backend, folderHash, workspace.gitCommonDir)).toBe(true);

    await fake.backend.stopContainer(single.id);

    expect(await gitDirInUseElsewhere(fake.backend, folderHash, workspace.gitCommonDir)).toBe(false);

    await ensureContainer({ backend: fake.backend, spec: specOf({ workspace: folder }) });

    expect(await gitDirInUseElsewhere(fake.backend, REPO_HASH, workspace.gitCommonDir)).toBe(true);
    expect(await gitDirInUseElsewhere(fake.backend, folderHash, workspace.gitCommonDir)).toBe(false);
  });
});

describe("volumes the sandbox writes", () => {
  const project = join(WORK, "repo", "web");
  const nodeWorkspace = { ...workspace, overlays: [join(project, "node_modules")] };
  const cachedSpec = (stateDir = LOCK_STATE) =>
    specOf({
      workspace: nodeWorkspace,
      stateDir,
      config: sandboxConfig({
        mounts: { extraReadOnly: [], cacheVolumes: [], sharedCaches: ["~/.cache/pip"] },
      }),
    });
  const chownsOf = (fake: ReturnType<typeof createFakeBackend>) =>
    fake.execs.filter((exec) => exec.spec.command[0] === "chown").map((exec) => exec.spec);

  beforeEach(async () => {
    await rm(project, { recursive: true, force: true });

    await mkdir(project, { recursive: true });
  });

  it("creates a missing mount point on the host before the container starts and records it", async () => {
    const fake = createFakeBackend();

    await ensureContainer({ backend: fake.backend, spec: cachedSpec() });

    expect((await stat(join(project, "node_modules"))).isDirectory()).toBe(true);
    expect(await readCreatedDirs(LOCK_STATE, REPO_HASH)).toContain(join(project, "node_modules"));
  });

  it("removes cache volumes of this repository that the new container no longer mounts", async () => {
    const fake = createFakeBackend();

    await fake.backend.ensureVolume("pi-sandbox-cache-stale", {
      "pi-sandbox.repo-hash": REPO_HASH,
      "pi-sandbox.cache-path": "gone/node_modules",
    });

    await fake.backend.ensureVolume("pi-sandbox-cache-foreign", {
      "pi-sandbox.repo-hash": "f".repeat(64),
      "pi-sandbox.cache-path": "gone/node_modules",
    });

    await ensureContainer({ backend: fake.backend, spec: cachedSpec() });

    expect(fake.volumes.has("pi-sandbox-cache-stale")).toBe(false);
    expect(fake.volumes.has("pi-sandbox-cache-foreign")).toBe(true);
  });

  it("refuses a mount point the sandbox side turned into a link", async () => {
    const fake = createFakeBackend();
    const elsewhere = join(WORK, "elsewhere");

    await mkdir(elsewhere, { recursive: true });

    await symlink(elsewhere, join(project, "node_modules"));

    await expect(ensureContainer({ backend: fake.backend, spec: cachedSpec() })).rejects.toThrow(
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

    const spec = specOf({ config: sandboxConfig({ mounts: { cacheVolumes: ["sym/x/y"] } }) });

    await expect(ensureContainer({ backend: fake.backend, spec })).rejects.toThrow(
      `the mount point ${join(link, "x")} leads outside ${workspace.repoRoot}`,
    );
    expect(await stat(join(outside, "x", "y")).catch(() => undefined)).toBeUndefined();
    expect([...fake.containers.values()]).toEqual([]);

    await rm(link, { force: true });
  });

  it("creates every missing directory of a nested mount point inside the repository", async () => {
    const fake = createFakeBackend();
    const spec = specOf({ config: sandboxConfig({ mounts: { cacheVolumes: ["deep/a/b"] } }) });

    await ensureContainer({ backend: fake.backend, spec });

    expect((await stat(join(WORK, "repo", "deep", "a", "b"))).isDirectory()).toBe(true);
  });

  it("runs no root exec on an older container adopted after a lost create race", async () => {
    const fake = createFakeBackend();
    const spec = cachedSpec();
    const racing = {
      ...fake.backend,
      createContainer: async () => {
        fake.addContainer({
          name: spec.name,
          labels: { ...spec.labels, "pi-sandbox.spec-hash": "older" },
          state: "running",
          image: spec.image,
        });

        throw new Error("container name is already in use");
      },
    };
    const result = await ensureContainer({ backend: racing, spec });

    expect(result.outdated).toBe(true);
    expect(fake.containers.get(result.id)?.summary.state).toBe("running");
    expect(chownsOf(fake)).toEqual([]);
  });

  it("hands every owned volume and the home dirs above a shared cache to the sandbox user as root on each start", async () => {
    const fake = createFakeBackend();
    const spec = cachedSpec();
    const first = await ensureContainer({ backend: fake.backend, spec });

    await fake.backend.stopContainer(first.id);

    await ensureContainer({ backend: fake.backend, spec });

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
    const result = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ workspace: nodeWorkspace }),
    });

    expect(result.notices).toEqual([
      "warning: the sandbox user may not be able to write its cache volumes: denied",
    ]);
  });

  it("runs no root exec when the sandbox has no volumes of its own to hand over", async () => {
    const fake = createFakeBackend();

    await ensureContainer({
      backend: fake.backend,
      spec: specOf({ config: sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: [] } }) }),
    });

    expect(chownsOf(fake)).toEqual([]);
  });

  it("labels repository volumes with the repository and shared caches with the user only", async () => {
    const fake = createFakeBackend();
    const spec = cachedSpec();

    await ensureContainer({ backend: fake.backend, spec });

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
