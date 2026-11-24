import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installIdOf, LABELS } from "../../backend/index.ts";
import { run, runPinata } from "../../cli/index.ts";
import { agentVolumeName, volumePlan } from "../../container/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import {
  launcherRoot,
  processMark,
  sha256Hex,
  shortHash,
  stateLayout,
  writeRepoRecord,
} from "../../shared/index.ts";
import { FAKE_NETWORK } from "../support/fake-backend.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, sweepNow, unreachable } from "./harness.ts";

const packageVersion = async () =>
  (JSON.parse(await readFile(join(launcherRoot(), "..", "package.json"), "utf8")) as { version: string })
    .version;

describe("pinata status", () => {
  it("reports runtime, proxy and image, and no container once the last session exited", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    expect(await runPinata(["status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`pinata: ${await packageVersion()}`);
    expect(lines.filter((line) => line.startsWith("runtime: "))).toEqual([]);
    expect(lines).toContain("runtime socket: /fake/docker.sock");
    expect(lines).toContain("containers: 0");
    expect(lines).toContain("proxy: stopped");
    expect(lines).toContain("image: pinata-base:local sha256:built-1");
    expect(lines).toContain("launches: 0 running in the sandbox");
    expect(lines).toContain("grants: 0 active");
  });

  it("names the shared pi folder and, in one place, what an older launcher left", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const layout = stateLayout(harness.stateDir);
    const agent = agentVolumeName(installIdOf(harness.stateDir));
    const legacy = `${agent}-0123456789ab`;
    const renders = layout.repo(sha256Hex(harness.repoRoot)).legacy.render;

    await run([], harness.deps);

    await fake.backend.ensureVolume(legacy, {});

    await mkdir(renders, { recursive: true });

    expect(await runPinata(["status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`pi folder: ${agent}, shared by every folder's sandbox`);
    expect(lines.filter((line) => line.startsWith("leftover: "))).toEqual([
      `leftover: volume ${legacy}, left by an older pinata; pinata restart removes it`,
      `leftover: ${layout.renders}, left by an older pinata; pinata restart removes it`,
    ]);
  });

  it("names a folder that is no repository a folder", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });
    const folder = join(harness.root, "workspace");

    await mkdir(folder, { recursive: true });

    expect(await runPinata(["status"], { ...harness.deps, cwd: folder })).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`folder: ${folder}`);
    expect(lines).toContain("launches: 0 running in the sandbox");
  });

  it("reports every launch container of this folder, and no relay", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const id = fake.addContainer({
      name: "pinata-repo",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.role]: "agent",
        [LABELS.repoHash]: sha256Hex(harness.repoRoot),
        [LABELS.imageDigest]: "sha256:one",
        [LABELS.launchId]: "00000000000000aa",
      },
      state: "running",
      image: "sha256:image-one",
    });

    fake.addContainer({
      name: "pinata-relay-repo",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.role]: "relay",
      },
      state: "running",
      image: "relay",
    });

    expect(await runPinata(["status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("containers: 1");
    expect(lines).toContain(`container: ${id} running launch 00000000000000aa digest sha256:one`);
  });

  it("reports the install's proxy without its token", async () => {
    const harness = await createHarness({
      proxy: { read: async () => ({ pid: 11, port: 4001, boot: 1, start: "", inputHash: "input" }) },
    });

    expect(await runPinata(["status"], harness.deps)).toBe(0);

    const proxies = harness
      .stdout()
      .split("\n")
      .filter((line) => line.startsWith("proxy: "));

    expect(proxies).toEqual(["proxy: pid 11 port 4001"]);
  });

  it("reports the live launches of the install with their folders, and the active grants", async () => {
    const harness = await createHarness();
    const other = "e".repeat(64);

    await writeRepoRecord(harness.stateDir, sha256Hex(harness.repoRoot), harness.repoRoot);

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "00000000000000e1",
      pid: process.pid,
      repoHash: other,
      startedAt: 1_700_000_000_000,
    });

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1_700_000_000_000,
    });

    await runPinata(["egress", "allow", "docs.example.test"], harness.deps);

    expect(await runPinata(["status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("launches: 2 running in the sandbox");
    expect(lines).toContain(
      `launch: 0123456789abcdef pid ${process.pid} since 2023-11-14T22:13:20.000Z in ${harness.repoRoot}`,
    );
    expect(lines).toContain(
      `launch: 00000000000000e1 pid ${process.pid} since 2023-11-14T22:13:20.000Z in repository ${shortHash(other)}`,
    );
    expect(lines).toContain("grants: 1 active");
    expect(lines).toContain("grant: docs.example.test");
  });

  it("still reports the proxy and image without a reachable engine", async () => {
    const fake = createFakeBackend();
    const down = { ...fake.backend, detect: async () => ({ available: false, reason: "socket missing" }) };
    const harness = await createHarness({ backend: () => down });

    expect(await runPinata(["status"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(
      "runtime: none (the sandbox VM engine is unreachable at ~/.colima/pinata/docker.sock: socket missing)",
    );
    expect(harness.stdout()).toContain("proxy: stopped");
    expect(harness.stdout()).toContain("(not built yet)");
  });
});

describe("pinata config", () => {
  it("prints the effective config followed by the source of each key", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { sessions: { host: false } });

    expect(await runPinata(["config"], harness.deps)).toBe(0);

    const output = harness.stdout();
    const json = output.slice(0, output.indexOf("\n# "));

    expect(JSON.parse(json).sessions.host).toBe(false);
    expect(output).toContain("# sessions.host: config\n");
    expect(output).toContain("# mounts.autoOverlays: default\n");
    expect(JSON.parse(json).image.reference).toBeUndefined();
  });

  it("prints config and sources as one JSON object with --json", async () => {
    const harness = await createHarness();

    expect(await runPinata(["config", "--json"], harness.deps)).toBe(0);

    const parsed = JSON.parse(harness.stdout()) as {
      config: { sessions: { host: boolean } };
      sources: Record<string, string>;
    };

    expect(parsed.config.sessions.host).toBe(true);
    expect(parsed.sources["sessions.host"]).toBe("default");
  });

  it("lists the effective write-back keys of each file with their source", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, {
      writeBack: {
        exclude: { "settings.json": ["theme"] },
        add: { "pi-footer.json": { layout: { type: "json" } } },
      },
    });

    expect(await runPinata(["config"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(
      "# writeBack settings.json default: defaultProvider, defaultModel, defaultThinkingLevel, enabledModels, hideThinkingBlock,",
    );
    expect(harness.stdout()).not.toMatch(/# writeBack settings\.json default: .*theme/);
    expect(harness.stdout()).toContain("# writeBack pi-footer.json config: layout\n");
    expect(harness.stdout()).toContain("# writeBack.exclude: config\n");

    expect(await runPinata(["config", "--json"], harness.deps)).toBe(0);

    const parsed = JSON.parse(harness.stdout().slice(harness.stdout().lastIndexOf("\n{\n") + 1)) as {
      writeBack: Record<string, Record<string, { source: string }>>;
    };

    expect(parsed.writeBack["pi-footer.json"]).toEqual({
      layout: { spec: { type: "json" }, source: "config" },
    });
    expect(parsed.writeBack["settings.json"]?.defaultModel?.source).toBe("default");
  });

  it("says when nothing is written back", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { writeBack: { enabled: false } });

    expect(await runPinata(["config"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("# writeBack: nothing is written back to the host\n");
  });

  it("only shows the config and refuses any other option", async () => {
    const harness = await createHarness();

    expect(await runPinata(["config", "set", "sessions.host", "false"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pinata: unknown config option "set"\n');
    expect(harness.stderr()).toContain("  hint: pinata config [--json]");
  });
});

describe("the sweep", () => {
  const orphanOf = async (
    fake: ReturnType<typeof createFakeBackend>,
    repoHash: string,
    launchId = "00000000000000ff",
  ) => {
    await fake.backend.prepareRelay({ hostPort: 3128, imageId: "relay", preamble: "PINATA test" });

    return fake.addContainer({
      name: `pinata-${repoHash.slice(0, 12)}`,
      labels: {
        [LABELS.managed]: "true",
        [LABELS.role]: "agent",
        [LABELS.repoHash]: repoHash,
        [LABELS.launchId]: launchId,
      },
      state: "running",
      image: "x",
    });
  };

  it("removes the container of a repository no live launch uses, then the relay, network and proxy of the idle install", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "b".repeat(64);
    const id = await orphanOf(fake, orphan);

    fake.addContainer({ name: "unrelated", labels: {}, state: "running", image: "x" });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.relays.size).toBe(0);
    expect(fake.networks.has(FAKE_NETWORK)).toBe(false);
    expect(harness.proxyStops()).toBe(1);
    expect(harness.stdout()).toContain(`removed container pinata-${orphan.slice(0, 12)} (${id})\n`);
    expect([...fake.containers.values()].map((entry) => entry.summary.name)).toEqual(["unrelated"]);
  });

  it("keeps the proxy, relay and container of a repository whose session is still preparing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "00000000000000bb",
      pid: process.pid,
      repoHash: repo,
      startedAt: 1,
    });

    const id = await orphanOf(fake, repo, "00000000000000bb");

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(harness.proxyStops()).toBe(0);
    expect(fake.containers.has(id)).toBe(true);
    expect(fake.relays.size).toBe(1);
  });

  it("forgets a repository whose root no longer exists, with its state and volumes", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const gone = await tempDir("gone-repo");
    const hash = sha256Hex(gone);
    const files = stateLayout(harness.stateDir).repo(hash);

    await harness.writeJson(files.record, { root: gone });

    await fake.backend.ensureVolume("pinata-agent-gone", {
      [LABELS.repoHash]: hash,
      [LABELS.repoRoot]: gone,
    });

    await rm(gone, { recursive: true, force: true });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await readFile(files.record, "utf8").catch(() => undefined)).toBeUndefined();
    expect(fake.volumes.has("pinata-agent-gone")).toBe(false);
    expect(harness.stdout()).toContain(`forgot ${gone}, which no longer exists\n`);
  });

  it("removes the dangling sandbox images no container uses and keeps the current base, images in use and foreign ones", async () => {
    const fake = createFakeBackend({ localImages: { "foreign:1": "sha256:foreign" } });
    const harness = await createHarness({ backend: () => fake.backend });
    const context = await tempDir("gc-images");
    const build = (tag: string) => fake.backend.buildImage(context, tag);
    const dangling = await build("pinata-layer:old");
    const used = await build("pinata-layer:used");
    const current = await build("pinata:base");

    fake.ageImages(2 * 60 * 60);

    await build("pinata-layer:old");

    await build("pinata-layer:used");

    await build("pinata:base");

    fake.addContainer({ name: "running", labels: {}, state: "running", image: used.id });

    await harness.writeJson(stateLayout(harness.stateDir).imageRecord, {
      base: { id: current.id, digest: current.digest, inputsHash: "pinned" },
    });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.imageRemovals).toEqual([dangling.id]);
    expect(harness.stdout()).toContain(`removed image ${dangling.id.replace(/^sha256:/, "").slice(0, 12)}\n`);
    expect((await fake.backend.listImages()).map((image) => image.id)).toEqual(
      expect.arrayContaining([used.id, current.id, "sha256:image-foreign"]),
    );
  });

  it("leaves the daily collection due when it ran without an engine, as under pinata stop of a stopped VM", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });

    expect(await runPinata(["stop"], harness.deps)).toBe(0);
    expect(
      await readFile(stateLayout(harness.stateDir).gcRecord, "utf8").catch(() => undefined),
    ).toBeUndefined();
  });

  it("removes what an interrupted image build left in the state dir, unless a build is running", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });
    const leftover = stateLayout(harness.stateDir).buildContext("build-0123abcd");

    await mkdir(leftover, { recursive: true });

    await writeFile(`${leftover}.tar`, "partial");

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await readFile(`${leftover}.tar`, "utf8").catch(() => undefined)).toBeUndefined();
  });

  const tokenOf = async (stateDir: string) => {
    const token = stateLayout(stateDir).proxy.token;

    await mkdir(join(token, ".."), { recursive: true });

    await writeFile(token, "f".repeat(64));

    return token;
  };

  it("runs the host side of the sweep when the VM is stopped", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const token = await tokenOf(harness.stateDir);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(harness.proxyStops()).toBe(1);
    expect(await readFile(token, "utf8").catch(() => undefined)).toBeUndefined();
    expect(harness.stderr()).not.toContain("unreachable");
  });

  it("removes a volume whose repository no longer exists on disk", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const gone = await tempDir("gone-repo");

    await fake.backend.ensureVolume("pinata-agent-gone", {
      [LABELS.repoHash]: sha256Hex(gone),
      [LABELS.repoRoot]: gone,
    });

    await rm(gone, { recursive: true, force: true });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has("pinata-agent-gone")).toBe(false);
    expect(harness.stdout()).toContain("removed volume pinata-agent-gone\n");
  });

  it("keeps the pi folder every folder's sandbox shares when the repository that made it is gone", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const agent = agentVolumeName(installIdOf(harness.stateDir));

    await run([], harness.deps);

    await rm(harness.repoRoot, { recursive: true, force: true });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has(agent)).toBe(true);
  });

  it("keeps the volumes of a repository that still exists after its container is removed", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [agent = ""] = volumePlan({
      workspace: { cwd: harness.repoRoot, repoRoot: harness.repoRoot, isGitRepo: true },
      config: sandboxConfig(),
      stateDir: harness.stateDir,
    }).map((volume) => volume.name);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(agent)).toBe(true);
    expect(harness.stdout()).not.toContain("removed volume");
  });

  it("keeps a volume without a repository label", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await fake.backend.ensureVolume("pinata-agent-unlabelled");

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has("pinata-agent-unlabelled")).toBe(true);
  });
});

describe("pinata help and version", () => {
  it("prints the launcher version from the package manifest", async () => {
    const harness = await createHarness();

    expect(await runPinata(["--version"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(`${await packageVersion()}\n`);
  });

  it("lists every pinata command in one list", async () => {
    const harness = await createHarness();

    expect(await runPinata(["help"], harness.deps)).toBe(0);

    const listed = harness
      .stdout()
      .split("\n")
      .map((line) => /^ {2}pinata (\S+)/.exec(line)?.[1])
      .filter((command) => command !== undefined);

    expect([...new Set(listed)]).toEqual([
      "install",
      "update",
      "uninstall",
      "init",
      "status",
      "list",
      "config",
      "egress",
      "restart",
      "stop",
      "doctor",
      "--version",
      "help",
    ]);
  });

  it("prints usage for help and for a bare pinata", async () => {
    const harness = await createHarness();

    expect(await runPinata(["help"], harness.deps)).toBe(0);
    expect(await runPinata([], harness.deps)).toBe(0);
    expect(harness.stdout().match(/pinata doctor/g)).toHaveLength(2);
    expect(harness.stdout()).not.toContain("pinata gc");
    expect(harness.stdout()).toContain("pinata restart  ");
  });

  const readmeRows = async () => {
    const readme = await readFile(join(launcherRoot(), "README.md"), "utf8");
    const start = readme.indexOf("| command | what it does |");
    const table = readme.slice(start, readme.indexOf("\n\n", start));
    const rows = table
      .split("\n")
      .slice(2)
      .filter((line) => line.startsWith("| `"));

    return rows.map((row) => {
      const [command = "", description = ""] = row
        .slice(2, -2)
        .replaceAll("\\|", "\u0000")
        .split(" | ")
        .map((cell) => cell.replaceAll("\u0000", "|"));

      return {
        commands: [...command.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""),
        description: description.replaceAll("`", ""),
      };
    });
  };

  it("lists every command of the README table with the same description, in aligned columns", async () => {
    const harness = await createHarness();

    await runPinata(["help"], harness.deps);

    const lines = harness.stdout().trimEnd().split("\n").slice(1);
    const rows = await readmeRows();
    const described = (command: string) => lines.find((line) => line.startsWith(`  ${command}  `));
    const columns = new Set(lines.map((line) => /^ {2}\S.*?\S {2,}(?=\S)/.exec(line)?.[0].length));

    expect(rows.flatMap((row) => row.commands).filter((command) => described(command) === undefined)).toEqual(
      [],
    );
    expect(
      rows
        .filter((row) => row.commands.length === 1)
        .filter((row) => !described(row.commands[0] ?? "")?.endsWith(`  ${row.description}`))
        .map((row) => row.commands[0]),
    ).toEqual([]);
    expect(columns.size).toBe(1);
    expect(lines).toHaveLength(rows.flatMap((row) => row.commands).length);
  });
});
