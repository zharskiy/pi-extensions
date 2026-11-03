import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "../../backend/index.ts";
import {
  collectGarbage,
  ensureContainer,
  findCurrentContainer,
  listLauncherContainers,
  removeRepoContainer,
} from "../../container/lifecycle.ts";
import { buildContainerSpec, type ContainerSpecInput } from "../../container/spec.ts";
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
    stateDir: "/state",
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

    expect(second).toEqual({ id: first.id, created: false });
    expect(fake.containers.size).toBe(1);
  });

  it("starts a matching container that is stopped", async () => {
    const fake = createFakeBackend();
    const first = await ensureContainer({ backend: fake.backend, spec: specOf() });

    await fake.backend.stopContainer(first.id);

    const second = await ensureContainer({ backend: fake.backend, spec: specOf() });

    expect(second).toEqual({ id: first.id, created: false });
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

  it("mounts a state-dir copy of the git config when the backend cannot mount single files", async () => {
    const repo = await newStateDir();
    const gitDir = join(repo, ".git");
    const fake = createFakeBackend({ capabilities: { singleFileMount: false } });

    await mkdir(gitDir, { recursive: true });
    await writeFile(join(gitDir, "config"), "[core]\n\tbare = false\n");

    const spec = specOf({
      workspace: { cwd: repo, repoRoot: repo, gitCommonDir: gitDir, isGitRepo: true },
      capabilities: { ...capabilities, singleFileMount: false },
      stateDir: state.dir,
    });
    const { id } = await ensureContainer({ backend: fake.backend, spec });
    const configMount = fake.containers
      .get(id)
      ?.spec?.mounts.find((mount) => mount.target === join(gitDir, "config"));

    expect(configMount?.readOnly).toBe(true);
    expect(configMount?.source.startsWith(spec.copiesDir)).toBe(true);
    expect(spec.copiesDir.startsWith(state.dir)).toBe(true);
    expect(await readFile(configMount?.source ?? "", "utf8")).toBe("[core]\n\tbare = false\n");
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
