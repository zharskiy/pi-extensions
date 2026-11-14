import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmInspect } from "../../backend/index.ts";
import { type DetectDeps, detectHost } from "../../cli/setup/detect.ts";
import { registerLaunch } from "../../grants/index.ts";
import { processMark } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { tempDir } from "../support/temp-dir.ts";

const GIB = 1024 ** 3;

const running: VmInspect = {
  state: "running",
  size: { cpus: 4, memoryGiB: 8, diskGiB: 60 },
  shares: [],
};

const depsOf = async (overrides: Partial<DetectDeps> = {}): Promise<DetectDeps> => {
  const home = await realpath(await tempDir("detect-home"));

  await mkdir(join(home, "Projects", "app", ".git"), { recursive: true });

  return {
    home,
    cwd: home,
    env: {},
    machine: { cpus: 12, memoryGiB: 32.7 },
    stateDir: join(home, "state"),
    configFile: join(home, "config.json"),
    docsFile: "/docs/CONFIGURATION.md",
    configRoots: undefined,
    firstRun: true,
    backend: createFakeBackend({ vm: { inspect: async () => running } }).backend,
    statfs: async () => ({ bavail: 100 * GIB, bsize: 1 }),
    ...overrides,
  };
};

const hanging = () => new Promise<never>(() => undefined);

describe("detectHost", () => {
  it("gathers the host, the VM, the sessions and the folders", async () => {
    const deps = await depsOf();
    const facts = await detectHost(deps);

    expect(facts).toMatchObject({
      home: deps.home,
      cpus: 12,
      memoryGiB: 32,
      freeDiskGiB: 100,
      vm: running,
      sessions: 0,
      configFile: deps.configFile,
      docsFile: "/docs/CONFIGURATION.md",
    });
    expect(facts.automatic).toEqual({ cpus: 8, memoryGiB: 10, diskGiB: 60 });
    expect(facts.candidates.map((candidate) => candidate.stored)).toEqual(["~/Projects"]);
  });

  it("reads the free disk of the colima folder, else of home", async () => {
    const asked: string[] = [];
    const deps = await depsOf({
      statfs: async (path) => {
        asked.push(path);

        if (path.endsWith(".colima")) {
          throw new Error("missing");
        }

        return { bavail: 7n, bsize: BigInt(GIB) };
      },
    });

    expect((await detectHost(deps)).freeDiskGiB).toBe(7);
    expect(asked).toEqual([join(deps.home, ".colima"), deps.home]);
  });

  it("leaves the free disk out when statfs fails", async () => {
    const deps = await depsOf({
      statfs: async () => {
        throw new Error("no statfs");
      },
    });

    expect(await detectHost(deps)).not.toHaveProperty("freeDiskGiB");
  });

  it("turns an inspect failure into an unknown VM with its reason", async () => {
    const backend = createFakeBackend({
      vm: {
        inspect: async () => {
          throw new Error("colima is not installed");
        },
      },
    }).backend;

    expect((await detectHost(await depsOf({ backend }))).vm).toEqual({
      state: "unknown",
      reason: "colima is not installed",
    });
  });

  it("gives up on what does not answer within the budget", async () => {
    const backend = createFakeBackend({ vm: { inspect: hanging } }).backend;
    const deps = await depsOf({ backend, statfs: hanging, budgetMs: 20 });
    const facts = await detectHost(deps);

    expect(facts.vm).toEqual({ state: "unknown", reason: "colima did not answer within 0.02 seconds" });
    expect(facts).not.toHaveProperty("freeDiskGiB");
  });

  it("says when the folder search ran out of time, and keeps the configured roots", async () => {
    const deps = await depsOf({ budgetMs: 0, configRoots: ["~/w"], firstRun: false });
    const facts = await detectHost(deps);

    expect(facts.searchTimedOut).toBe(true);
    expect(facts.candidates).toMatchObject([{ stored: "~/w", origin: "config", exists: true }]);
  });

  it("counts the live pi sessions", async () => {
    const deps = await depsOf();

    await registerLaunch(deps.stateDir, {
      launchId: "0123456789abcdef",
      ...(await processMark()),
      repoHash: "a".repeat(64),
      startedAt: 1,
    });

    expect((await detectHost(deps)).sessions).toBe(1);
  });
});
