import { execFileSync } from "node:child_process";
import { chmod, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ContainerSpec, ExecSpec } from "../../backend/index.ts";
import { configVolumeName } from "../../container/names.ts";
import {
  extractCommand,
  markerCheckCommand,
  markerReadCommand,
  markerRemoveCommand,
  markerWriteCommand,
  SEED_MARKER,
  type SeedInput,
  seedVolumes,
  type VolumeSeed,
  volumeSeeds,
} from "../../container/seed.ts";
import { createFakeBackend, type FakeExec, stdinOf } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir } from "../support/temp-dir.ts";

const TARGET = "/home/pi/.m2/repository";

const MARKER = `${TARGET}/${SEED_MARKER}`;

interface Scenario {
  marker?: string;
  guestCode?: number;
  readsArchive?: boolean;
  markerWriteCode?: number;
  onExtract?: () => void;
}

const CONTAINER_SPEC: ContainerSpec = {
  name: "pinata-seed-test",
  image: "sha256:image-one",
  labels: {},
  mounts: [],
  network: { kind: "none" },
  env: {},
  workdir: "/",
  readOnlyRoot: true,
  tmpfs: [],
  init: true,
  resources: { pids: 4096 },
  capabilities: [],
  autoRemove: false,
};

const isCommand = (spec: ExecSpec, program: string) => spec.command[0] === program;

const fakeSandbox = async (scenario: Scenario = {}) => {
  const state: { marker?: string } = { marker: scenario.marker };
  const fake = createFakeBackend({
    exec: async (spec, io) => {
      if (isCommand(spec, "test")) {
        return state.marker === undefined ? 1 : 0;
      }

      if (isCommand(spec, "head")) {
        io.stdout.write(state.marker ?? "");

        return 0;
      }

      if (isCommand(spec, "rm")) {
        state.marker = undefined;

        return 0;
      }

      if (isCommand(spec, "dd")) {
        const chunks: Buffer[] = [];

        io.stdin?.on("data", (chunk: Buffer) => chunks.push(chunk));

        await new Promise((resolve) => io.stdin?.once("end", resolve));

        if (scenario.markerWriteCode !== undefined) {
          io.stderr.write("dd: failed to open: File exists\n");

          return scenario.markerWriteCode;
        }

        state.marker = Buffer.concat(chunks).toString();

        return 0;
      }

      if (!isCommand(spec, "tar")) {
        return undefined;
      }

      scenario.onExtract?.();

      if (scenario.readsArchive === false) {
        return 0;
      }

      await new Promise((resolve) => {
        io.stdin?.once("end", resolve);

        io.stdin?.once("close", resolve);
      });

      if (scenario.guestCode !== undefined && scenario.guestCode !== 0) {
        io.stderr.write("tar: Unexpected EOF in archive\n");
      }

      return scenario.guestCode ?? 0;
    },
  });
  const { id } = await fake.backend.createContainer(CONTAINER_SPEC);

  await fake.backend.startContainer(id);

  return { fake, id, state };
};

type Sandbox = Awaited<ReturnType<typeof fakeSandbox>>;

const seedOf = (source: string, volume = "pinata-shared-test", requested = source): VolumeSeed => ({
  requested,
  source,
  shownSource: "~/.m2/repository",
  shownTarget: "~/.m2/repository",
  target: TARGET,
  volume,
});

const runSeeds = async (sandbox: Sandbox, seeds: VolumeSeed[], overrides: Partial<SeedInput> = {}) => {
  const lines: string[] = [];
  const stateDir = await tempDir("seed-state");

  await seedVolumes({
    backend: sandbox.fake.backend,
    containerId: sandbox.id,
    stateDir,
    seeds,
    signal: new AbortController().signal,
    progress: (line) => lines.push(line),
    ...overrides,
  });

  return lines;
};

const archiveNames = (exec: FakeExec | undefined) =>
  exec === undefined
    ? []
    : execFileSync("/usr/bin/tar", ["-t", "-f", "-"], { input: stdinOf(exec) })
        .toString()
        .split("\n")
        .filter((name) => name !== "")
        .sort();

const commandsOf = (sandbox: Sandbox) => sandbox.fake.execs.map((exec) => exec.spec.command);

const extractOf = (sandbox: Sandbox) => sandbox.fake.execs.find((exec) => isCommand(exec.spec, "tar"));

const wroteMarker = (sandbox: Sandbox) => commandsOf(sandbox).some((command) => command[0] === "dd");

const sourceTree = async () => {
  const root = await realpath(await tempDir("seed-source"));
  const source = join(root, "repository");
  const outside = join(root, "outside");

  await mkdir(join(source, "org", "lib", "1.0"), { recursive: true });

  await mkdir(join(outside, "inner"), { recursive: true });

  await writeFile(join(source, "org", "lib", "1.0", "lib-1.0.jar"), "jar");

  await writeFile(join(outside, "inner", "secret"), "secret content");

  await writeFile(join(source, "._lib-1.0.jar"), "apple double");

  await symlink("../outside", join(source, "linked"));

  await symlink("org/lib", join(source, "short"));

  execFileSync("/usr/bin/mkfifo", [join(source, "pipe")]);

  return { root, source, outside };
};

const COPYING = "pinata: copying ~/.m2/repository into the volume at ~/.m2/repository, one time";

const notCopied = (reason: string) =>
  `pinata: warning: ~/.m2/repository was not copied into the volume at ~/.m2/repository (${reason}); the next launch tries again`;

describe("volumeSeeds", () => {
  it("pairs each source with its volume's guest target and Docker name, as written in the config", () => {
    const config = sandboxConfig({
      mounts: {
        volumes: ["/opt/plain", { target: "~/.m2/repository/", name: "maven", source: "~/.m2/repository" }],
      },
    });
    const seeds = volumeSeeds(config, "/state", [
      { index: 1, written: "~/.m2/repository", requested: "/home/m2", source: "/real/m2" },
    ]);

    expect(seeds).toEqual([
      {
        requested: "/home/m2",
        source: "/real/m2",
        shownSource: "~/.m2/repository",
        shownTarget: "~/.m2/repository/",
        target: TARGET,
        volume: configVolumeName("/state", "maven"),
      },
    ]);
  });
});

describe("seedVolumes", () => {
  it("streams the archive into tar in the sandbox, then replaces the marker with one naming the source", async () => {
    const { source } = await sourceTree();
    const sandbox = await fakeSandbox();
    const lines = await runSeeds(sandbox, [seedOf(source)]);
    const extract = extractOf(sandbox);

    expect(commandsOf(sandbox)).toEqual([
      markerCheckCommand(MARKER),
      extractCommand(TARGET),
      markerRemoveCommand(MARKER),
      markerWriteCommand(MARKER),
    ]);
    expect(extract?.spec.user).toBeUndefined();
    expect(archiveNames(extract)).toEqual([
      "linked",
      "org/",
      "org/lib/",
      "org/lib/1.0/",
      "org/lib/1.0/lib-1.0.jar",
      "short",
    ]);
    expect(stdinOf(extract as FakeExec).includes(Buffer.from("secret content"))).toBe(false);
    expect(sandbox.state.marker).toBe(`${source}\n`);
    expect(lines).toEqual([COPYING, "pinata: copied ~/.m2/repository into the volume at ~/.m2/repository"]);
  });

  it("runs every sandbox command as an argument list, the marker checked as a file that is no link and created exclusively", () => {
    expect(extractCommand(TARGET)).toEqual([
      "tar",
      "-x",
      "-f",
      "-",
      "-C",
      TARGET,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    expect(markerCheckCommand(MARKER)).toEqual(["test", "-f", MARKER, "-a", "!", "-L", MARKER]);
    expect(markerReadCommand(MARKER)).toEqual(["head", "-c", "4096", "--", MARKER]);
    expect(markerRemoveCommand(MARKER)).toEqual(["rm", "-f", "--", MARKER]);
    expect(markerWriteCommand(MARKER)).toEqual(["dd", `of=${MARKER}`, "conv=excl", "status=none"]);
  });

  it("says how many entries were left out and still writes the marker", async () => {
    const { source } = await sourceTree();

    await writeFile(join(source, "locked"), "l");

    await chmod(join(source, "locked"), 0o000);

    const sandbox = await fakeSandbox();
    const lines = await runSeeds(sandbox, [seedOf(source)]);

    expect(archiveNames(extractOf(sandbox))).not.toContain("locked");
    expect(sandbox.state.marker).toBe(`${source}\n`);
    expect(lines.at(-1)).toBe(
      "pinata: copied ~/.m2/repository into the volume at ~/.m2/repository; 1 entry could not be read and was left out",
    );
  });

  it("copies nothing and prints nothing when the marker names this source or nothing", async () => {
    const { source } = await sourceTree();

    await Promise.all(
      [`${source}\n`, ""].map(async (marker) => {
        const sandbox = await fakeSandbox({ marker });
        const lines = await runSeeds(sandbox, [seedOf(source)]);

        expect(commandsOf(sandbox)).toEqual([markerCheckCommand(MARKER), markerReadCommand(MARKER)]);
        expect(lines).toEqual([]);
      }),
    );
  });

  it("copies nothing and says so when the marker names another source", async () => {
    const { source } = await sourceTree();
    const sandbox = await fakeSandbox({ marker: "/Volumes/other/repository\n" });
    const lines = await runSeeds(sandbox, [seedOf(source)]);

    expect(extractOf(sandbox)).toBeUndefined();
    expect(wroteMarker(sandbox)).toBe(false);
    expect(lines).toEqual([
      `pinata: warning: the volume at ~/.m2/repository holds a copy of /Volumes/other/repository, so ~/.m2/repository is not copied into it; delete ~/.m2/repository/${SEED_MARKER} in the sandbox to copy it`,
    ]);
  });

  it("copies once when two launches seed one volume at once, the second finding the marker", async () => {
    const { source } = await sourceTree();
    const sandbox = await fakeSandbox();
    const stateDir = await tempDir("seed-shared-state");

    await Promise.all([
      runSeeds(sandbox, [seedOf(source)], { stateDir }),
      runSeeds(sandbox, [seedOf(source)], { stateDir }),
    ]);

    expect(commandsOf(sandbox).filter((command) => command[0] === "tar")).toHaveLength(1);
    expect(commandsOf(sandbox).filter((command) => command[0] === "dd")).toHaveLength(1);
  });

  it("gives one notice and no marker when the source does not exist or is not a folder", async () => {
    const root = await realpath(await tempDir("seed-missing"));
    const file = join(root, "file");

    await writeFile(file, "x");

    const sandbox = await fakeSandbox();
    const lines = await runSeeds(sandbox, [
      seedOf(join(root, "missing")),
      seedOf(file, "pinata-shared-other"),
    ]);

    expect(extractOf(sandbox)).toBeUndefined();
    expect(wroteMarker(sandbox)).toBe(false);
    expect(lines).toEqual([
      COPYING,
      notCopied("~/.m2/repository does not exist"),
      COPYING,
      notCopied("~/.m2/repository is not a folder"),
    ]);
  });

  it("copies nothing when the source now resolves to another folder than when the config was read", async () => {
    const { root, source, outside } = await sourceTree();
    const requested = join(root, "pointer");

    await symlink(source, requested);

    const seed = seedOf(await realpath(requested), "pinata-shared-test", requested);

    await rm(requested);

    await symlink(outside, requested);

    const sandbox = await fakeSandbox();
    const lines = await runSeeds(sandbox, [seed]);

    expect(extractOf(sandbox)).toBeUndefined();
    expect(wroteMarker(sandbox)).toBe(false);
    expect(lines.at(-1)).toBe(
      notCopied(`~/.m2/repository now resolves to ${outside}, not to ${source} as when the config was read`),
    );
  });

  it("names the sandbox tar's failure and writes no marker", async () => {
    const { source } = await sourceTree();
    const sandbox = await fakeSandbox({ guestCode: 2 });
    const lines = await runSeeds(sandbox, [seedOf(source)]);

    expect(wroteMarker(sandbox)).toBe(false);
    expect(lines.at(-1)).toBe(
      notCopied("tar in the sandbox exited with code 2: tar: Unexpected EOF in archive"),
    );
  });

  it("writes no marker when tar in the sandbox exits 0 before the archive reached its end", async () => {
    const { source } = await sourceTree();
    const sandbox = await fakeSandbox({ readsArchive: false });
    const lines = await runSeeds(sandbox, [seedOf(source)]);

    expect(wroteMarker(sandbox)).toBe(false);
    expect(lines.at(-1)).toBe(notCopied("the archive ended before its last entry"));
  });

  it("names a marker that could not be written, as when a link sits at its name", async () => {
    const { source } = await sourceTree();
    const sandbox = await fakeSandbox({ markerWriteCode: 1 });
    const lines = await runSeeds(sandbox, [seedOf(source)]);

    expect(commandsOf(sandbox).slice(-2)).toEqual([markerRemoveCommand(MARKER), markerWriteCommand(MARKER)]);
    expect(lines.at(-1)).toBe(
      notCopied(`the marker ${SEED_MARKER} could not be written: dd: failed to open: File exists`),
    );
  });

  it("calls an interrupted copy interrupted and writes no marker", async () => {
    const { source } = await sourceTree();
    const controller = new AbortController();
    const sandbox = await fakeSandbox({ onExtract: () => controller.abort() });
    const lines = await runSeeds(sandbox, [seedOf(source)], { signal: controller.signal });

    expect(wroteMarker(sandbox)).toBe(false);
    expect(lines.at(-1)).toBe(notCopied("the copy was interrupted"));
  });
});
