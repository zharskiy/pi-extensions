import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectGarbage,
  ensureContainer,
  findCurrentContainer,
  gitDirInUseElsewhere,
  listLauncherContainers,
  removeRepoContainer,
} from "../../container/lifecycle.ts";
import { buildContainerSpec, type ContainerSpecInput } from "../../container/spec.ts";
import { sha256Hex } from "../../shared/index.ts";
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

  it("starts a matching container that is stopped", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });

    await fake.backend.stopContainer(first.id);

    const second = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(second).toMatchObject({ id: first.id, created: false, outdated: false });
    expect(fake.containers.get(first.id)?.summary.state).toBe("running");
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
        policyHash: "p",
      },
    });
    const second = await ensureContainer({ backend: fake.backend, spec: rerouted });

    expect(second.created).toBe(true);
    expect(fake.containers.has(first.id)).toBe(false);
    expect(fake.containers.get(second.id)?.spec?.env.HTTPS_PROXY).toBe("http://pi-sandbox:t@10.89.0.9:3128");
  });

  it("replaces a stopped container whose spec is stale", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });

    await fake.backend.stopContainer(first.id);

    const trusted = specOf({ trust: { pemPath: "/state/ca/trust.pem", hash: "trust-2" } });
    const second = await ensureContainer({ backend: fake.backend, spec: trusted });

    expect(second.created).toBe(true);
    expect(fake.containers.has(first.id)).toBe(false);
    expect(fake.containers.get(second.id)?.spec?.env.PI_SANDBOX_TRUST_HASH).toBe("trust-2");
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

  it("reuses the container another launcher created under the same name", async () => {
    const fake = createFakeBackend();
    const spec = specOf();
    const raced = { id: "" };
    const backend = {
      ...fake.backend,
      createContainer: async () => {
        raced.id = fake.addContainer({ name: spec.name, labels: spec.labels, state: "created", image: "x" });

        throw new Error(`container name ${spec.name} is already in use`);
      },
    };
    const result = await ensureContainer({ backend, spec });

    expect(result).toMatchObject({ id: raced.id, created: false, outdated: false });
    expect(fake.containers.get(raced.id)?.summary.state).toBe("running");
  });
});

describe("ensureContainer and the repository network", () => {
  const routedSpec = async (fake: ReturnType<typeof createFakeBackend>, launcherVersion: string) => {
    const route = await fake.backend.prepareProxyRoute({
      hostPort: 3128,
      repoHash: sha256Hex(workspace.repoRoot),
      relay: { policyHash: "p", imageId: "sha256:image-one" },
    });

    return specOf({
      launcherVersion,
      proxy: { url: "http://pi-sandbox:t@10.89.0.2:3128", network: route.network, policyHash: "p" },
    });
  };

  it("replaces an outdated container without tearing down the network the new one joins", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: await routedSpec(fake, "0.4.0") });
    const spec = await routedSpec(fake, "0.5.0");
    const second = await ensureContainer({ backend: fake.backend, spec });

    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(fake.containers.get(second.id)?.summary.state).toBe("running");
    expect(spec.network.kind === "internal" && fake.networks.has(spec.network.name)).toBe(true);
  });

  it("still removes the repository network when its last container is removed by reset or gc", async () => {
    const reset = createFakeBackend();
    const collected = createFakeBackend();
    const resetSpec = await routedSpec(reset, "0.4.0");
    const collectedSpec = await routedSpec(collected, "0.4.0");
    const { id } = await ensureContainer({ backend: collected.backend, spec: collectedSpec });

    await ensureContainer({ backend: reset.backend, spec: resetSpec });

    await removeRepoContainer(reset.backend, workspace.repoRoot);

    await collected.backend.stopContainer(id);

    await collectGarbage(collected.backend);

    expect(reset.networks.size).toBe(0);
    expect(collected.networks.size).toBe(0);
  });
});

describe("ensureContainer with a stopped container", () => {
  it("starts a stopped container whose spec is current instead of creating one", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    await fake.backend.stopContainer(id);

    const again = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(again).toMatchObject({ id, created: false, outdated: false });
    expect(fake.containers.get(id)?.summary.state).toBe("running");
  });
});

describe("container housekeeping", () => {
  it("lists only launcher containers", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    fake.addContainer({ name: "unrelated", labels: {}, state: "running", image: "busybox" });

    expect((await listLauncherContainers(fake.backend)).map((container) => container.id)).toEqual([id]);
  });

  it("garbage-collects stopped launcher containers and keeps running ones", async () => {
    const fake = createFakeBackend();
    const running = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const other = specOf({
      workspace: { cwd: `${WORK}/other`, repoRoot: `${WORK}/other`, isGitRepo: false },
    });
    const stopped = await ensureContainer({ backend: fake.backend, spec: other });
    const unrelated = fake.addContainer({
      name: "unrelated",
      labels: {},
      state: "stopped",
      image: "busybox",
    });

    await fake.backend.stopContainer(stopped.id);

    const garbage = await collectGarbage(fake.backend);

    expect(garbage.containers.map((container) => container.id)).toEqual([stopped.id]);
    expect([...fake.containers.keys()].sort()).toEqual([running.id, unrelated].sort());
  });

  it("stops and removes the container of one repo", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    const removed = await removeRepoContainer(fake.backend, workspace.repoRoot);

    expect(removed.map((container) => container.id)).toEqual([id]);
    expect(fake.containers.size).toBe(0);
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

describe("relay garbage collection", () => {
  const proxyFor = (policyHash: string) => ({
    url: "http://pi-sandbox:t@10.89.0.2:3128",
    network: { kind: "internal" as const, name: "pi-sandbox" },
    policyHash,
  });

  const relay = (fake: ReturnType<typeof createFakeBackend>, policyHash: string) =>
    fake.addContainer({
      name: `pi-sandbox-relay-${policyHash}`,
      labels: {
        "pi-sandbox.managed": "true",
        "pi-sandbox.relay": "true",
        "pi-sandbox.proxy-policy-hash": policyHash,
      },
      state: "running",
      image: "relay",
    });

  it("removes relays no running container uses and reports the policy hashes still in use", async () => {
    const fake = createFakeBackend();
    const used = relay(fake, "policy-used");
    const idle = relay(fake, "policy-idle");

    await ensureContainer({ backend: fake.backend, spec: specOf({ proxy: proxyFor("policy-used") }) });

    const garbage = await collectGarbage(fake.backend);

    expect(garbage.relays.map((entry) => entry.id)).toEqual([idle]);
    expect(garbage.policyHashesInUse).toEqual(["policy-used"]);
    expect(fake.containers.has(used)).toBe(true);
    expect(fake.containers.has(idle)).toBe(false);
  });

  it("never lists a relay as a launcher container", async () => {
    const fake = createFakeBackend();

    relay(fake, "policy");

    expect(await listLauncherContainers(fake.backend)).toEqual([]);
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

    expect(await gitDirInUseElsewhere(fake.backend, worktree)).toBe(true);
    expect(await gitDirInUseElsewhere(fake.backend, submodule)).toBe(true);
    expect(await gitDirInUseElsewhere(fake.backend, unrelated)).toBe(false);
    expect(await gitDirInUseElsewhere(fake.backend, workspace)).toBe(false);

    await fake.backend.stopContainer(id);

    expect(await gitDirInUseElsewhere(fake.backend, worktree)).toBe(false);
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

    expect(await gitDirInUseElsewhere(fake.backend, folder, workspace.gitCommonDir)).toBe(true);

    await fake.backend.stopContainer(single.id);

    expect(await gitDirInUseElsewhere(fake.backend, folder, workspace.gitCommonDir)).toBe(false);

    await ensureContainer({ backend: fake.backend, spec: specOf({ workspace: folder }) });

    expect(await gitDirInUseElsewhere(fake.backend, workspace)).toBe(true);
    expect(await gitDirInUseElsewhere(fake.backend, folder, workspace.gitCommonDir)).toBe(false);
  });
});

describe("volumes the sandbox writes", () => {
  const project = join(WORK, "repo", "web");
  const nodeWorkspace = { ...workspace, nodeProjects: [project] };
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

  it("creates a missing mount point on the host before the container starts", async () => {
    const fake = createFakeBackend();

    await ensureContainer({ backend: fake.backend, spec: cachedSpec() });

    expect((await stat(join(project, "node_modules"))).isDirectory()).toBe(true);
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
          state: "stopped",
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
    });
    expect(labelsOf("/home/pi/.cache/pip")).toEqual({
      "pi-sandbox.managed": "true",
      "pi-sandbox.user-hash": sha256Hex(LOCK_STATE).slice(0, 12),
      "pi-sandbox.shared-path": "~/.cache/pip",
    });
  });
});
