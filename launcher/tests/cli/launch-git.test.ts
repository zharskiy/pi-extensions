import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex } from "../../shared/index.ts";
import { createFakeBackend, createHarness } from "./harness.ts";

const OUTDATED =
  "pi-sandbox: the sandbox config changed; it applies after every session in this repository exits";

const absent = async (path: string) => (await lstat(path).catch(() => undefined)) === undefined;

describe("the commondir pin around container starts", () => {
  it("is in place at every container start and gone after each last session", async () => {
    const fake = createFakeBackend();
    const pinsAtStart: string[] = [];
    const harness = await createHarness({
      backend: () => ({
        ...fake.backend,
        startContainer: async (id: string) => {
          pinsAtStart.push(await readFile(join(harness.repoRoot, ".git", "commondir"), "utf8"));

          await fake.backend.startContainer(id);
        },
      }),
    });
    const pin = join(harness.repoRoot, ".git", "commondir");

    expect(await run([], harness.deps)).toBe(0);
    expect(await absent(pin)).toBe(true);

    expect(await run([], harness.deps)).toBe(0);
    expect(fake.created).toHaveLength(2);
    expect(pinsAtStart).toEqual([".\n", ".\n"]);
    expect(await absent(pin)).toBe(true);
  });

  it("refuses a repository whose commondir the sandbox rewrote, naming the file, and starts nothing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const pin = join(harness.repoRoot, ".git", "commondir");

    await writeFile(pin, "../.x\n");

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pi-sandbox: git: ${pin} was not written by git or the launcher`);
    expect(fake.containers.size).toBe(0);
    expect(harness.calls.some((call) => call.file === "git")).toBe(false);
  });

  it("says so when it joins a running sandbox whose config changed", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "00000000000000aa",
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1,
      pid: process.pid,
    });

    expect(await run([], harness.deps)).toBe(0);

    await harness.writeJson(harness.userConfigFile, { mounts: { cacheVolumes: ["vendor"] } });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(OUTDATED);
  });
});
