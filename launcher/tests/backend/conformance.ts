import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type * as Vitest from "vitest";
import { type Backend, type ContainerSpec, LABELS } from "../../backend/index.ts";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";

interface NetworkTraits {
  managed: boolean;
  internal: boolean;
}

interface ConformanceNetworks {
  has: (name: string) => Promise<boolean>;
  remove: (name: string) => Promise<void>;
  plant?: (name: string, traits: NetworkTraits) => Promise<void>;
}

export interface ConformanceTarget {
  backend: Backend;
  pullableImage: string;
  runnableImage: string;
  relayImage?: string;
  networks: ConformanceNetworks;
  dispose?: () => Promise<void>;
}

interface ConformanceScope {
  sharedRuntime?: boolean;
}

export interface ConformanceHooks {
  describe: (name: string, body: () => void) => void;
  it: (name: string, body: () => Promise<void>) => void;
  expect: typeof Vitest.expect;
  beforeAll: (body: () => Promise<void>) => void;
  afterAll: (body: () => Promise<void>) => void;
}

const WRONG_DIGEST = `sha256:${"0".repeat(64)}`;

const RUN_LABEL = "pi-sandbox.conformance";

const GREETING = "hello from the host\n";

const PIPED_INPUT = "piped input\n";

const SHORT_REPO_HASH = 12;

const randomHash = () => randomBytes(32).toString("hex");

const networkOf = (repoHash: string) => `pi-sandbox-${repoHash.slice(0, SHORT_REPO_HASH)}`;

const tarRunner = createProcessRunner();

const tar = async (args: string[]) => {
  const result = await tarRunner.run("tar", args, { env: { COPYFILE_DISABLE: "1" } });

  if (result.code !== 0) {
    throw new Error(`tar ${args.join(" ")}: ${result.stderr}`);
  }
};

const inputOf = (text = "") => {
  const stdin = new PassThrough();

  stdin.end(text);

  return stdin;
};

export const runBackendConformance = (
  title: string,
  hooks: ConformanceHooks,
  factory: () => Promise<ConformanceTarget>,
  scope: ConformanceScope = {},
) => {
  const { describe, it, expect, beforeAll, afterAll } = hooks;
  const runId = randomBytes(4).toString("hex");
  const prefix = `pi-sandbox-conformance-${runId}`;
  const volumes = [`${prefix}-a`, `${prefix}-b`, `${prefix}-mounted`, `${prefix}-owned`, `${prefix}-listed`];
  const policyHash = randomHash();
  const repos = [randomHash(), randomHash(), randomHash(), randomHash(), randomHash()];
  const state: { target?: ConformanceTarget; workDir?: string } = {};

  const target = () => {
    if (state.target === undefined) {
      throw new Error("conformance target was not created");
    }

    return state.target;
  };

  const backend = () => target().backend;

  const specFor = (name: string, labels: Record<string, string>): ContainerSpec => ({
    name: `${prefix}-${name}`,
    image: target().runnableImage,
    labels: { [RUN_LABEL]: runId, ...labels },
    mounts: [{ kind: "volume", source: `${prefix}-mounted`, target: "/data", readOnly: false }],
    network: { kind: "none" },
    env: { PI_SANDBOX_CONFORMANCE: "1" },
    workdir: "/",
    readOnlyRoot: true,
    tmpfs: ["/tmp"],
    init: true,
    resources: { cpus: 1, memoryGiB: 0.25 },
  });

  const collector = () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));

    return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
  };

  const networks = () => target().networks;

  const plant = (name: string, traits: NetworkTraits) => {
    const planter = networks().plant;

    if (planter === undefined) {
      throw new Error("this conformance target cannot plant networks");
    }

    return planter(name, traits);
  };

  const routeFor = async (repoHash: string, hostPort = 3128) => {
    await backend().pullImage(target().pullableImage);

    return backend().prepareProxyRoute({
      hostPort,
      repoHash,
      relay: { policyHash, imageId: target().relayImage ?? target().runnableImage },
    });
  };

  const createOn = async (name: string, repoHash: string) => {
    const route = await routeFor(repoHash);

    return backend().createContainer({
      ...specFor(name, { [LABELS.repoHash]: repoHash }),
      network: route.network,
    });
  };

  const runExec = async (containerId: string, script: string, input = "") => {
    const stdout = collector();
    const stderr = collector();
    const exitCode = await backend().exec(
      { containerId, command: ["sh", "-c", script], env: {}, workdir: "/" },
      { stdin: inputOf(input), stdout: stdout.stream, stderr: stderr.stream, tty: false },
    );

    return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
  };

  describe(`${title} backend conformance`, () => {
    beforeAll(async () => {
      state.target = await factory();
      state.workDir = await mkdtemp(join(tmpdir(), "pi-sandbox-conformance-"));
    });

    afterAll(async () => {
      const leftovers =
        state.target === undefined ? [] : await backend().findContainers({ [RUN_LABEL]: runId });

      await Promise.all(leftovers.map((container) => backend().removeContainer(container.id)));

      const relays =
        state.target === undefined
          ? []
          : await backend().findContainers({ [LABELS.relay]: "true", [LABELS.proxyPolicyHash]: policyHash });

      await Promise.all(relays.map((relay) => backend().removeContainer(relay.id)));

      await Promise.all(
        repos.map((repoHash) => state.target?.networks.remove(networkOf(repoHash)).catch(() => undefined)),
      );

      await Promise.all(
        volumes.map((volume) => (state.target === undefined ? undefined : backend().removeVolume(volume))),
      );

      await state.target?.dispose?.();

      if (state.workDir !== undefined) {
        await rm(state.workDir, { recursive: true, force: true });
      }
    });

    it("detects the runtime and reports a version", async () => {
      const detection = await backend().detect();

      expect(detection.available).toBe(true);
      expect(detection.version).toEqual(expect.any(String));
    });

    it("pulls a missing image and returns its digest, accepting that digest afterwards", async () => {
      const first = await backend().pullImage(target().pullableImage);
      const pinned = await backend().pullImage(target().pullableImage, first.digest);

      expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(pinned.digest).toBe(first.digest);
      expect(await backend().resolveImage(pinned.id)).toMatchObject({ digest: first.digest });
    });

    it("resolves a local image by reference and misses an absent one", async () => {
      const pulled = await backend().pullImage(target().pullableImage);

      expect(await backend().resolveImage(target().pullableImage)).toMatchObject({ digest: pulled.digest });
      expect(await backend().resolveImage(`${prefix}/absent:1`)).toBeUndefined();
    });

    it("refuses an image whose digest differs from the expected one", async () => {
      const refused = backend().pullImage(target().pullableImage, WRONG_DIGEST);

      await expect(refused).rejects.toBeInstanceOf(LauncherError);
      await expect(refused).rejects.toThrow(WRONG_DIGEST);
    });

    it("finds a created container by all of its labels", async () => {
      const created = await backend().createContainer(specFor("find", { "pi-sandbox.repo-hash": "find" }));

      const found = await backend().findContainers({ [RUN_LABEL]: runId, "pi-sandbox.repo-hash": "find" });
      const unrelated = await backend().findContainers({
        [RUN_LABEL]: runId,
        "pi-sandbox.repo-hash": "other",
      });

      expect(found.map((container) => container.id)).toEqual([created.id]);
      expect(found[0]).toMatchObject({ name: `${prefix}-find`, labels: { "pi-sandbox.repo-hash": "find" } });
      expect(unrelated).toEqual([]);

      await backend().removeContainer(created.id);
    });

    it("refuses a duplicate name and recreates under the same name after removal", async () => {
      const old = await backend().createContainer(specFor("recreate", { "pi-sandbox.config-hash": "old" }));

      await expect(
        backend().createContainer(specFor("recreate", { "pi-sandbox.config-hash": "new" })),
      ).rejects.toBeInstanceOf(LauncherError);

      await backend().startContainer(old.id);

      await backend().stopContainer(old.id);

      await backend().removeContainer(old.id);

      const replacement = await backend().createContainer(
        specFor("recreate", { "pi-sandbox.config-hash": "new" }),
      );

      expect(await backend().findContainers({ [RUN_LABEL]: runId, "pi-sandbox.config-hash": "old" })).toEqual(
        [],
      );
      expect(
        (await backend().findContainers({ [RUN_LABEL]: runId, "pi-sandbox.config-hash": "new" })).map(
          (container) => container.id,
        ),
      ).toEqual([replacement.id]);

      await backend().removeContainer(replacement.id);
    });

    it("starts a container and passes exec exit codes through", async () => {
      const created = await backend().createContainer(specFor("exec", {}));

      await backend().startContainer(created.id);

      const listed = await backend().findContainers({ [RUN_LABEL]: runId });

      expect(listed.find((container) => container.id === created.id)?.state).toBe("running");
      expect((await runExec(created.id, "exit 3")).exitCode).toBe(3);
      expect((await runExec(created.id, "exit 0")).exitCode).toBe(0);

      await backend().removeContainer(created.id);
    });

    it("runs an exec as the user it names", async () => {
      const created = await backend().createContainer(specFor("exec-user", {}));
      const uidAs = async (user: string) => {
        const stdout = collector();
        const exitCode = await backend().exec(
          { containerId: created.id, command: ["id", "-u"], env: {}, workdir: "/", user },
          { stdout: stdout.stream, stderr: collector().stream, tty: false },
        );

        return { exitCode, stdout: stdout.text() };
      };

      await backend().startContainer(created.id);

      expect(await uidAs("0")).toEqual({ exitCode: 0, stdout: "0\n" });
      expect(await uidAs("1000:1000")).toEqual({ exitCode: 0, stdout: "1000\n" });

      await backend().removeContainer(created.id);
    });

    it("delivers exec stdout and stderr to their own streams", async () => {
      const created = await backend().createContainer(specFor("streams", {}));

      await backend().startContainer(created.id);

      expect(await runExec(created.id, "echo hi; echo oops >&2")).toEqual({
        exitCode: 0,
        stdout: "hi\n",
        stderr: "oops\n",
      });

      await backend().removeContainer(created.id);
    });

    it("round-trips a volume through export and import", async () => {
      const workDir = state.workDir ?? "";
      const source = join(workDir, "source");
      const restored = join(workDir, "restored");

      await mkdir(join(source, "volume"), { recursive: true });

      await writeFile(join(source, "volume", "hello.txt"), GREETING);

      await tar(["-c", "-f", join(workDir, "seed.tar"), "-C", source, "volume"]);

      await backend().ensureVolume(volumes[0] ?? "");

      await backend().importVolume(volumes[0] ?? "", join(workDir, "seed.tar"), target().runnableImage);

      await backend().exportVolume(volumes[0] ?? "", join(workDir, "first.tar"), target().runnableImage);

      await backend().importVolume(volumes[1] ?? "", join(workDir, "first.tar"), target().runnableImage);

      await backend().exportVolume(volumes[1] ?? "", join(workDir, "second.tar"), target().runnableImage);

      await mkdir(restored, { recursive: true });

      await tar(["-x", "-f", join(workDir, "second.tar"), "-C", restored]);

      expect(await readFile(join(restored, "volume", "hello.txt"), "utf8")).toBe(GREETING);
    });

    it("refuses to export a volume that does not exist", async () => {
      await expect(
        backend().exportVolume(
          `${prefix}-missing`,
          join(state.workDir ?? "", "missing.tar"),
          target().runnableImage,
        ),
      ).rejects.toBeInstanceOf(LauncherError);
    });

    it("removes volumes idempotently", async () => {
      await backend().ensureVolume(volumes[0] ?? "");

      await backend().removeVolume(volumes[0] ?? "");

      await expect(backend().removeVolume(volumes[0] ?? "")).resolves.toBeUndefined();
    });

    it("lists a managed volume with the labels it was created with, keeping them when ensured again", async () => {
      const owned = volumes[3] ?? "";
      const owner = { [LABELS.repoHash]: repos[0] ?? "", [LABELS.repoRoot]: "/work/owned" };

      await backend().ensureVolume(owned, owner);

      await backend().ensureVolume(owned, { [LABELS.repoRoot]: "/work/other" });

      const listed = (await backend().listVolumes()).find((volume) => volume.name === owned);

      expect(listed?.labels).toEqual(expect.objectContaining({ ...owner, [LABELS.managed]: "true" }));
      expect(listed?.inUse).toBe(false);

      await backend().removeVolume(owned);

      expect((await backend().listVolumes()).map((volume) => volume.name)).not.toContain(owned);
    });

    it("reports a volume mounted by a container as in use until the container is removed", async () => {
      const mounted = volumes[4] ?? "";

      await backend().pullImage(target().pullableImage);

      await backend().ensureVolume(mounted);

      const created = await backend().createContainer({
        ...specFor("in-use", {}),
        mounts: [{ kind: "volume", source: mounted, target: "/data", readOnly: false }],
      });
      const inUse = async () =>
        (await backend().listVolumes()).find((volume) => volume.name === mounted)?.inUse;

      expect(await inUse()).toBe(true);

      await backend().removeContainer(created.id);

      expect(await inUse()).toBe(false);
    });

    it("passes exec stdin through to the command", async () => {
      const created = await backend().createContainer(specFor("stdin", {}));

      await backend().startContainer(created.id);

      expect(await runExec(created.id, "cat", PIPED_INPUT)).toEqual({
        exitCode: 0,
        stdout: PIPED_INPUT,
        stderr: "",
      });

      await backend().removeContainer(created.id);
    });

    it("stops a running container within the given timeout", async () => {
      const created = await backend().createContainer(specFor("stop", {}));

      await backend().startContainer(created.id);

      await backend().stopContainer(created.id, 1);

      const listed = await backend().findContainers({ [RUN_LABEL]: runId });

      expect(listed.find((container) => container.id === created.id)?.state).toBe("stopped");

      await backend().removeContainer(created.id);
    });

    it("routes each repository over its own internal network, the same one on every call", async () => {
      const [repoA = "", repoB = ""] = repos;
      const routeA = await routeFor(repoA);
      const again = await routeFor(repoA);
      const routeB = await routeFor(repoB);

      expect(routeA.network).toEqual({ kind: "internal", name: networkOf(repoA) });
      expect(routeB.network).toEqual({ kind: "internal", name: networkOf(repoB) });
      expect(again).toEqual(routeA);
      expect(routeA.address).toMatch(/^\d+\.\d+\.\d+\.\d+:\d+$/);
      expect(await networks().has(networkOf(repoA))).toBe(true);
      expect(await networks().has(networkOf(repoB))).toBe(true);
    });

    it("drops a repository's network with its last container unless asked to keep it", async () => {
      const [repoA = "", repoB = ""] = repos;
      const first = await createOn("net-a1", repoA);
      const second = await createOn("net-a2", repoA);
      const other = await createOn("net-b", repoB);

      await backend().removeContainer(first.id);

      expect(await networks().has(networkOf(repoA))).toBe(true);

      await backend().removeContainer(second.id, { keepNetwork: true });

      expect(await networks().has(networkOf(repoA))).toBe(true);

      const third = await createOn("net-a3", repoA);

      await backend().removeContainer(third.id);

      expect(await networks().has(networkOf(repoA))).toBe(false);
      expect(await networks().has(networkOf(repoB))).toBe(true);

      await backend().removeContainer(other.id);
    });

    if (scope.sharedRuntime !== true) {
      it("refuses a network of the repository's name that it does not manage or that is not internal", async () => {
        const [, , repoC = "", repoD = ""] = repos;

        await plant(networkOf(repoC), { managed: false, internal: true });

        await plant(networkOf(repoD), { managed: true, internal: false });

        const unmanaged = routeFor(repoC);
        const external = routeFor(repoD);

        await expect(unmanaged).rejects.toBeInstanceOf(LauncherError);
        await expect(unmanaged).rejects.toThrow("exists but is not managed by pi-sandbox");
        await expect(external).rejects.toBeInstanceOf(LauncherError);
        await expect(external).rejects.toThrow("exists but is not internal");
      });

      it("prunes the launcher's networks of repositories outside the keep set and nothing else", async () => {
        const [repoA = "", repoB = "", , , repoE = ""] = repos;
        const unrelated = `${prefix}-network`;

        await routeFor(repoA);

        await routeFor(repoB);

        await plant("pi-sandbox", { managed: true, internal: true });

        await plant(networkOf(repoE), { managed: false, internal: true });

        await plant(unrelated, { managed: true, internal: true });

        const pruned = await backend().pruneNetworks([repoA]);

        expect(pruned).toEqual(expect.arrayContaining(["pi-sandbox", networkOf(repoB)]));
        expect(pruned).not.toContain(networkOf(repoA));
        expect(pruned).not.toContain(networkOf(repoE));
        expect(pruned).not.toContain(unrelated);
        expect(await networks().has("pi-sandbox")).toBe(false);
        expect(await networks().has(networkOf(repoB))).toBe(false);
        expect(await networks().has(networkOf(repoA))).toBe(true);
        expect(await networks().has(networkOf(repoE))).toBe(true);
        expect(await networks().has(unrelated)).toBe(true);
      });
    }
  });
};
