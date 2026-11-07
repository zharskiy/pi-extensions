import { EventEmitter } from "node:events";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { liveSessions, registerSession } from "../../grants/index.ts";
import { sha256Hex } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness } from "./harness.ts";

const harnesses: Array<{ cleanup(): Promise<void> }> = [];

const harnessWith = async (options: Parameters<typeof createHarness>[0] = {}) => {
  const harness = await createHarness(options);

  harnesses.push(harness);

  return harness;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

const OUTDATED =
  "pi-sandbox: the sandbox config changed; it applies after every session in this repository exits";

const OTHER_LAUNCH = "00000000000000aa";

const never = () => new Promise<never>(() => undefined);

describe("a config change while other sessions of the repository are live", () => {
  it("keeps the shared container with a notice, then replaces it once the others have exited", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });
    const other = {
      launchId: OTHER_LAUNCH,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
      pid: process.pid,
    };

    await registerSession(harness.stateDir, other);

    expect(await run([], harness.deps)).toBe(0);

    const [first] = [...fake.containers.keys()];

    await harness.writeJson(harness.userConfigFile, { mounts: { cacheVolumes: ["vendor"] } });

    expect(await run([], harness.deps)).toBe(0);
    expect([...fake.containers.keys()]).toEqual([first]);
    expect(harness.stderr()).toContain(OUTDATED);
    expect(fake.stops).toEqual([]);

    await registerSession(harness.stateDir, { ...other, pid: 2 ** 22 + 12345 });

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.containers.has(first ?? "")).toBe(false);
    expect(fake.containers.size).toBe(1);
  });
});

describe("a signal while the sandbox is being prepared", () => {
  it("ends the session, stops the idle container and exits 128 plus the signal number", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const backend = {
      ...fake.backend,
      startContainer: async (id: string) => {
        await fake.backend.startContainer(id);

        signals.emit("SIGTERM");

        return never();
      },
    };
    const harness = await harnessWith({ adapters: () => [backend] });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(143);
    expect(fake.stops.map((stop) => stop.id)).toEqual([...fake.containers.keys()]);
    expect(await liveSessions(harness.stateDir)).toEqual([]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(fake.execs).toHaveLength(0);
  });

  it("exits 130 on Ctrl-C during the image build", async () => {
    const signals = new EventEmitter();
    const fake = createFakeBackend();
    const backend = {
      ...fake.backend,
      buildImage: async () => {
        signals.emit("SIGINT");

        return never();
      },
    };
    const harness = await harnessWith({ adapters: () => [backend] });

    harness.deps.signals = signals;

    expect(await run([], harness.deps)).toBe(130);
    expect(fake.containers.size).toBe(0);
    expect(await liveSessions(harness.stateDir)).toEqual([]);
  });
});

describe("pi --no-sandbox with an org baseline", () => {
  it("never fetches the baseline, so an unreachable org source without a cache does not block host pi", async () => {
    const harness = await harnessWith();
    const hostDir = join(harness.root, "host-bin");

    await mkdir(hostDir, { recursive: true });

    await writeFile(join(hostDir, "pi"), "#!/bin/sh\necho host pi\n");

    await chmod(join(hostDir, "pi"), 0o755);

    harness.deps.env.PATH = hostDir;

    await harness.writeJson(harness.userConfigFile, { org: { source: "https://org.invalid/baseline.json" } });

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain("the org layer is skipped");
    expect(harness.stderr()).not.toContain("could not fetch");
  });
});

describe("the proxy route of a repository", () => {
  it("asks the backend for the repository's own network", async () => {
    const fake = createFakeBackend();
    const asked: Array<string | undefined> = [];
    const backend = {
      ...fake.backend,
      prepareProxyRoute: (hostPort: number, policyHash: string, imageId: string, repoHash?: string) => {
        asked.push(repoHash);

        return fake.backend.prepareProxyRoute(hostPort, policyHash, imageId, repoHash);
      },
    };
    const harness = await harnessWith({ adapters: () => [backend] });

    expect(await run([], harness.deps)).toBe(0);
    expect(asked).toEqual([sha256Hex(harness.repoRoot)]);
  });
});
