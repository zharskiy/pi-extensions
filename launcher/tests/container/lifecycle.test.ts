import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "../../backend/index.ts";
import {
  collectGarbage,
  ensureContainer,
  findCurrentContainer,
  listLauncherContainers,
  removeRepoContainer,
  stopIdleContainer,
} from "../../container/lifecycle.ts";
import { buildContainerSpec, type ContainerSpecInput } from "../../container/spec.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const capabilities: BackendCapabilities = {
  singleFileMount: true,
  sshAgent: true,
  internalNetwork: true,
};

const workspace = {
  cwd: "/work/repo/src",
  repoRoot: "/work/repo",
  gitCommonDir: "/work/repo/.git",
  isGitRepo: true,
};

const stateDirs: string[] = [];

const LOCK_STATE = mkdtempSync(join(tmpdir(), "pi-sandbox-lifecycle-lock-"));

afterAll(() => {
  rmSync(LOCK_STATE, { recursive: true, force: true });
});

const specOf = (overrides: Partial<ContainerSpecInput> = {}) =>
  buildContainerSpec({
    workspace,
    config: sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: ["node_modules"] } }),
    image: { reference: "pi-sandbox:local", digest: "sha256:one", id: "sha256:image-one" },
    hostEnv: { USER: "dev" },
    hostUid: 501,
    hostGid: 20,
    platform: "darwin",
    capabilities,
    stateDir: LOCK_STATE,
    launcherVersion: "0.4.0",
    configHash: "cfg-one",
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

    expect(second).toEqual({ id: first.id, created: false, outdated: false });
    expect(fake.containers.size).toBe(1);
  });

  it("starts a matching container that is stopped", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });

    await fake.backend.stopContainer(first.id);

    const second = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(second).toEqual({ id: first.id, created: false, outdated: false });
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

    await stopIdleContainer(fake.backend, first.id);

    const trusted = specOf({ trust: { pemPath: "/state/ca/trust.pem", hash: "trust-2" } });
    const second = await ensureContainer({ backend: fake.backend, spec: trusted });

    expect(second.created).toBe(true);
    expect(fake.containers.has(first.id)).toBe(false);
    expect(fake.containers.get(second.id)?.spec?.env.PI_SANDBOX_TRUST_HASH).toBe("trust-2");
  });

  it("replaces the container when the config hash changes", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const second = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ configHash: "cfg-two" }),
    });

    expect(second.created).toBe(true);
    expect(fake.containers.has(first.id)).toBe(false);
  });

  it("keeps the running container of a changed config while other sessions of the repo are live", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const second = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ configHash: "cfg-two" }),
      othersLive: async () => true,
    });

    expect(second).toEqual({ id: first.id, created: false, outdated: true });
    expect(fake.stops).toEqual([]);
    expect([...fake.containers.keys()]).toEqual([first.id]);
  });

  it("replaces the container of a changed config once no other session is live", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });
    const second = await ensureContainer({
      backend: fake.backend,
      spec: specOf({ configHash: "cfg-two" }),
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

    expect(result).toEqual({ id: raced.id, created: false, outdated: false });
    expect(fake.containers.get(raced.id)?.summary.state).toBe("running");
  });

  it("binds copies as directories, never single files, when the backend cannot mount single files", async () => {
    const repo = await newStateDir();
    const gitDir = join(repo, ".git");
    const trustPem = join(repo, "trust.pem");
    const fake = createFakeBackend({ capabilities: { singleFileMount: false } });

    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "config"), "[core]\n\tbare = false\n");
    await writeFile(trustPem, "pem\n");

    const spec = specOf({
      workspace: { cwd: repo, repoRoot: repo, gitCommonDir: gitDir, isGitRepo: true },
      capabilities: { ...capabilities, singleFileMount: false },
      stateDir: state.dir,
      proxy: {
        url: "http://pi-sandbox:t@10.89.0.2:3128",
        network: { kind: "internal", name: "n" },
        policyHash: "p",
      },
      trust: { pemPath: trustPem, hash: "trust-1" },
    });
    const { id } = await ensureContainer({ backend: fake.backend, spec });
    const mounts = fake.containers.get(id)?.spec?.mounts ?? [];
    const copied = mounts.filter((mount) => mount.source.startsWith(spec.copiesDir));
    const sources = await Promise.all(copied.map((mount) => stat(mount.source)));

    expect(copied.map((mount) => mount.target)).toEqual(["/etc/pi-sandbox"]);
    expect(sources.every((info) => info.isDirectory())).toBe(true);
    expect(await readFile(join(copied[0]?.source ?? "", "ca.pem"), "utf8")).toBe("pem\n");
    expect(mounts.some((mount) => mount.target === join(gitDir, "config"))).toBe(false);
  });
});

describe("ensureContainer and the repository network", () => {
  const routedSpec = async (fake: ReturnType<typeof createFakeBackend>, configHash: string) => {
    const route = await fake.backend.prepareProxyRoute(
      3128,
      "p",
      "sha256:image-one",
      sha256Hex(workspace.repoRoot),
    );

    return specOf({
      configHash,
      proxy: { url: "http://pi-sandbox:t@10.89.0.2:3128", network: route.network, policyHash: "p" },
    });
  };

  it("replaces an outdated container without tearing down the network the new one joins", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: await routedSpec(fake, "cfg-one") });
    const spec = await routedSpec(fake, "cfg-two");
    const second = await ensureContainer({ backend: fake.backend, spec });

    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(fake.containers.get(second.id)?.summary.state).toBe("running");
    expect(spec.network.kind === "internal" && fake.networks.has(spec.network.name)).toBe(true);
  });

  it("still removes the repository network when its last container is removed by reset or gc", async () => {
    const reset = createFakeBackend();
    const collected = createFakeBackend();
    const resetSpec = await routedSpec(reset, "cfg-one");
    const collectedSpec = await routedSpec(collected, "cfg-one");
    const { id } = await ensureContainer({ backend: collected.backend, spec: collectedSpec });

    await ensureContainer({ backend: reset.backend, spec: resetSpec });

    await removeRepoContainer(reset.backend, workspace.repoRoot);

    await collected.backend.stopContainer(id);

    await collectGarbage(collected.backend);

    expect(reset.networks.size).toBe(0);
    expect(collected.networks.size).toBe(0);
  });
});

describe("stopIdleContainer", () => {
  it("stops a running container and keeps it for the next launch", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(await stopIdleContainer(fake.backend, id)).toEqual({ stopped: true });
    expect(fake.containers.get(id)?.summary.state).toBe("stopped");

    const again = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(again).toEqual({ id, created: false, outdated: false });
    expect(fake.containers.get(id)?.summary.state).toBe("running");
  });

  it("does nothing for a container that is already stopped or gone", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    await stopIdleContainer(fake.backend, id);

    expect(await stopIdleContainer(fake.backend, id)).toEqual({ stopped: false });
    expect(await stopIdleContainer(fake.backend, "container-missing")).toEqual({ stopped: false });
    expect(fake.stops).toHaveLength(1);
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
    const other = specOf({ workspace: { cwd: "/work/other", repoRoot: "/work/other", isGitRepo: false } });
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
  it("finds the repository's container only for the same digest and config hash", async () => {
    const fake = createFakeBackend();
    const { id } = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect((await findCurrentContainer(fake.backend, workspace, "sha256:one", "cfg-one"))?.id).toBe(id);
    expect(await findCurrentContainer(fake.backend, workspace, "sha256:two", "cfg-one")).toBeUndefined();
    expect(await findCurrentContainer(fake.backend, workspace, "sha256:one", "cfg-two")).toBeUndefined();
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
