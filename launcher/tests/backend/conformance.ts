import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import type * as Vitest from "vitest";
import {
  type Backend,
  type ContainerInspect,
  type ContainerSpec,
  LABELS,
  networkName,
  relayName,
} from "../../backend/index.ts";
import { LauncherError } from "../../shared/index.ts";

interface ConformanceNetworks {
  has: (name: string) => Promise<boolean>;
  remove: (name: string) => Promise<void>;
  plantForeign?: (name: string) => Promise<void>;
}

export interface ConformanceTarget {
  backend: Backend;
  install: string;
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

const RUN_LABEL = "pinata.conformance";

const PIPED_INPUT = "piped input\n";

const randomHash = () => randomBytes(32).toString("hex");

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
  const prefix = `pinata-conformance-${runId}`;
  const volumes = [`${prefix}-a`, `${prefix}-b`, `${prefix}-mounted`, `${prefix}-owned`, `${prefix}-listed`];
  const repos = [randomHash(), randomHash(), randomHash(), randomHash(), randomHash()];
  const state: { target?: ConformanceTarget } = {};

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
    env: { PINATA_CONFORMANCE: "1" },
    workdir: "/",
    readOnlyRoot: true,
    tmpfs: ["/tmp"],
    init: true,
    resources: { cpus: 1, memoryGiB: 0.25, pids: 4096 },
    capabilities: ["CHOWN"],
    autoRemove: true,
  });

  const collector = () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];

    stream.on("data", (chunk: Buffer) => chunks.push(chunk));

    return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
  };

  const networks = () => target().networks;

  const plantForeign = (name: string) => {
    const planter = networks().plantForeign;

    if (planter === undefined) {
      throw new Error("this conformance target cannot plant networks");
    }

    return planter(name);
  };

  const ownNetwork = () => networkName(target().install);

  const relays = () => backend().findContainers({ [LABELS.role]: "relay" });

  const removeRelays = async () => {
    const found = await relays();

    await Promise.all(found.map((relay) => backend().removeContainer(relay.id)));
  };

  const routeFor = async (hostPort = 3128) => {
    await backend().pullImage(target().pullableImage);

    return backend().prepareRelay({
      hostPort,
      imageId: target().relayImage ?? target().runnableImage,
      preamble: "PINATA t0k3n",
    });
  };

  const createOn = async (name: string, repoHash: string) => {
    const network = await routeFor();

    return backend().createContainer({
      ...specFor(name, { [LABELS.repoHash]: repoHash }),
      network: { kind: "internal", name: network },
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
    });

    afterAll(async () => {
      const leftovers =
        state.target === undefined ? [] : await backend().findContainers({ [RUN_LABEL]: runId });

      await Promise.all(leftovers.map((container) => backend().removeContainer(container.id)));

      await Promise.all(
        volumes.map((volume) => (state.target === undefined ? undefined : backend().removeVolume(volume))),
      );

      await state.target?.dispose?.();
    });

    it("detects the runtime", async () => {
      expect(await backend().detect()).toEqual({ available: true });
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
      const created = await backend().createContainer(specFor("find", { "pinata.repo-hash": "find" }));

      const found = await backend().findContainers({ [RUN_LABEL]: runId, "pinata.repo-hash": "find" });
      const unrelated = await backend().findContainers({
        [RUN_LABEL]: runId,
        "pinata.repo-hash": "other",
      });

      expect(found.map((container) => container.id)).toEqual([created.id]);
      expect(found[0]).toMatchObject({ name: `${prefix}-find`, labels: { "pinata.repo-hash": "find" } });
      expect(unrelated).toEqual([]);

      await backend().removeContainer(created.id);
    });

    it("refuses a duplicate name and recreates under the same name after removal", async () => {
      const old = await backend().createContainer(specFor("recreate", { "pinata.config-hash": "old" }));

      await expect(
        backend().createContainer(specFor("recreate", { "pinata.config-hash": "new" })),
      ).rejects.toBeInstanceOf(LauncherError);

      await backend().startContainer(old.id);

      await backend().stopContainer(old.id);

      await backend().removeContainer(old.id);

      const replacement = await backend().createContainer(
        specFor("recreate", { "pinata.config-hash": "new" }),
      );

      expect(await backend().findContainers({ [RUN_LABEL]: runId, "pinata.config-hash": "old" })).toEqual([]);
      expect(
        (await backend().findContainers({ [RUN_LABEL]: runId, "pinata.config-hash": "new" })).map(
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

    it("removes a stopped container by itself, and a removal after it returns once it is gone", async () => {
      const created = await backend().createContainer(specFor("stop", {}));

      await backend().startContainer(created.id);

      await backend().stopContainer(created.id, 1);

      await backend().removeContainer(created.id);

      const listed = await backend().findContainers({ [RUN_LABEL]: runId });

      expect(listed.find((container) => container.id === created.id)).toBeUndefined();

      await backend().removeContainer(created.id);
    });

    it("keeps a container that is not auto-removed after it exits, with its exit code and last log lines", async () => {
      const created = await backend().createContainer({
        ...specFor("exited", {}),
        autoRemove: false,
        entrypoint: ["sh", "-c"],
        command: ["echo one; echo two >&2; echo three; exit 4"],
      });

      await backend().startContainer(created.id);

      const exited = async (): Promise<ContainerInspect | undefined> => {
        const inspected = await backend().inspectContainer(created.id);

        if (inspected?.state !== "running") {
          return inspected;
        }

        await new Promise((done) => setTimeout(done, 50));

        return exited();
      };

      expect(await exited()).toMatchObject({ id: created.id, state: "stopped", exitCode: 4 });

      const lines = (await backend().containerLogs(created.id, 10)).split("\n").filter(Boolean);

      expect([...lines].sort()).toEqual(["one", "three", "two"]);
      expect(lines.indexOf("one")).toBeLessThan(lines.indexOf("three"));
      expect(await backend().containerLogs(created.id, 2)).toBe(`${lines.slice(-2).join("\n")}\n`);

      await backend().removeContainer(created.id);

      expect(await backend().inspectContainer(created.id)).toBeUndefined();
      expect(await backend().containerLogs(created.id, 2)).toBe("");
    });

    it("stops a container that is not auto-removed and keeps it until it is removed", async () => {
      const created = await backend().createContainer({ ...specFor("kept", {}), autoRemove: false });

      await backend().startContainer(created.id);

      expect((await backend().inspectContainer(created.id))?.state).toBe("running");

      await backend().stopContainer(created.id, 1);

      expect((await backend().inspectContainer(created.id))?.state).toBe("stopped");

      await backend().removeContainer(created.id);

      expect(await backend().inspectContainer(created.id)).toBeUndefined();
    });

    if (scope.sharedRuntime !== true) {
      it("routes every session over the install's network through one relay, the same on every call", async () => {
        const network = await routeFor();
        const again = await routeFor();
        const found = await relays();

        expect(network).toBe(ownNetwork());
        expect(again).toBe(network);
        expect(found.map((relay) => relay.name)).toEqual([relayName(target().install)]);
        expect(found[0]?.labels[LABELS.install]).toBe(target().install);
        expect(found[0]?.labels[LABELS.repoHash]).toBeUndefined();
        expect(await networks().has(network)).toBe(true);
      });

      it("removes a network only once no container is attached, says whether it removed one, and tolerates a missing one", async () => {
        const [repoA = ""] = repos;
        const attached = await createOn("net-a1", repoA);

        await backend().startContainer(attached.id);

        await expect(backend().removeNetwork()).resolves.toBe(false);

        expect(await networks().has(ownNetwork())).toBe(true);

        await backend().removeContainer(attached.id);

        await removeRelays();

        await expect(backend().removeNetwork()).resolves.toBe(true);

        expect(await networks().has(ownNetwork())).toBe(false);

        await expect(backend().removeNetwork()).resolves.toBe(false);
      });

      it("refuses a network of its name that it does not manage", async () => {
        await networks().remove(ownNetwork());

        await plantForeign(ownNetwork());

        const unmanaged = routeFor();

        await expect(unmanaged).rejects.toBeInstanceOf(LauncherError);
        await expect(unmanaged).rejects.toThrow("exists but is not managed by pinata");

        await networks().remove(ownNetwork());
      });

      it("removes its own network and no other", async () => {
        const foreign = `${prefix}-foreign`;

        await routeFor();

        await plantForeign(foreign);

        await removeRelays();

        await backend().removeNetwork();

        expect(await networks().has(ownNetwork())).toBe(false);
        expect(await networks().has(foreign)).toBe(true);

        await networks().remove(foreign);
      });
    }
  });
};
