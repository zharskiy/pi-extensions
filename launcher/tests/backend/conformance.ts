import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type * as Vitest from "vitest";
import type { Backend, ContainerSpec } from "../../backend/index.ts";
import { createProcessRunner, LauncherError } from "../../shared/index.ts";

export interface ConformanceTarget {
  backend: Backend;
  pullableImage: string;
  runnableImage: string;
  dispose?: () => Promise<void>;
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

const tarRunner = createProcessRunner();

const tar = async (args: string[]) => {
  const result = await tarRunner.run("tar", args, { env: { COPYFILE_DISABLE: "1" } });

  if (result.code !== 0) {
    throw new Error(`tar ${args.join(" ")}: ${result.stderr}`);
  }
};

const closedInput = () => {
  const stdin = new PassThrough();

  stdin.end();

  return stdin;
};

export const runBackendConformance = (
  title: string,
  hooks: ConformanceHooks,
  factory: () => Promise<ConformanceTarget>,
) => {
  const { describe, it, expect, beforeAll, afterAll } = hooks;
  const runId = randomBytes(4).toString("hex");
  const prefix = `pi-sandbox-conformance-${runId}`;
  const volumes = [`${prefix}-a`, `${prefix}-b`, `${prefix}-mounted`];
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

  const runExec = async (containerId: string, script: string) => {
    const stdout = collector();
    const stderr = collector();
    const exitCode = await backend().exec(
      { containerId, command: ["sh", "-c", script], env: {}, workdir: "/" },
      { stdin: closedInput(), stdout: stdout.stream, stderr: stderr.stream, tty: false },
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
  });
};
