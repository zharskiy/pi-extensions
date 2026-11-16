import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { repoVolumes } from "../../container/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { launcherRoot, processMark, sha256Hex, stateLayout } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";
import { tempDir } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, sweepNow, unreachable } from "./harness.ts";

const packageVersion = async () =>
  (JSON.parse(await readFile(join(launcherRoot(), "..", "package.json"), "utf8")) as { version: string })
    .version;

describe("pi sandbox status", () => {
  it("reports runtime, proxy and image, and no container once the last session exited", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`launcher: ${await packageVersion()}`);
    expect(lines.filter((line) => line.startsWith("runtime: "))).toEqual([]);
    expect(lines).toContain("runtime socket: /fake/docker.sock");
    expect(lines).toContain("containers: 0");
    expect(lines).toContain("proxy: stopped");
    expect(lines).toContain("image: pi-sandbox-base:local sha256:built-1");
    expect(lines).toContain(`launches: 0 running in ${harness.repoRoot}`);
    expect(lines).toContain("grants: 0 active");
  });

  it("names a folder that is no repository a workspace", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });
    const folder = join(harness.root, "workspace");

    await mkdir(folder, { recursive: true });

    expect(await run(["sandbox", "status"], { ...harness.deps, cwd: folder })).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`workspace: ${folder}`);
    expect(lines).toContain(`launches: 0 running in ${folder}`);
  });

  it("reports every launch container of this folder, and no relay", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const id = fake.addContainer({
      name: "pi-sandbox-repo",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.repoHash]: sha256Hex(harness.repoRoot),
        [LABELS.imageDigest]: "sha256:one",
        [LABELS.launchId]: "00000000000000aa",
      },
      state: "running",
      image: "sha256:image-one",
    });

    fake.addContainer({
      name: "pi-sandbox-relay-repo",
      labels: {
        [LABELS.managed]: "true",
        [LABELS.repoHash]: sha256Hex(harness.repoRoot),
        [LABELS.relay]: "true",
      },
      state: "running",
      image: "relay",
    });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain("containers: 1");
    expect(lines).toContain(`container: ${id} running launch 00000000000000aa digest sha256:one`);
  });

  it("reports the proxy of this repository without its token", async () => {
    const harness = await createHarness({
      proxy: { read: async () => ({ pid: 11, port: 4001, boot: 1, start: "", inputHash: "input" }) },
    });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const proxies = harness
      .stdout()
      .split("\n")
      .filter((line) => line.startsWith("proxy: "));

    expect(proxies).toEqual(["proxy: pid 11 port 4001"]);
  });

  it("reports live launches and active grants of this repository", async () => {
    const harness = await createHarness();

    await registerLaunch(harness.stateDir, {
      ...(await processMark()),
      launchId: "0123456789abcdef",
      pid: process.pid,
      repoHash: sha256Hex(harness.repoRoot),
      startedAt: 1_700_000_000_000,
    });

    await run(["sandbox", "egress", "allow", "docs.example.test"], harness.deps);

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);

    const lines = harness.stdout().split("\n");

    expect(lines).toContain(`launches: 1 running in ${harness.repoRoot}`);
    expect(lines).toContain(`launch: 0123456789abcdef pid ${process.pid} since 2023-11-14T22:13:20.000Z`);
    expect(lines).toContain("grants: 1 active");
    expect(lines).toContain("grant: docs.example.test for this repository");
  });

  it("still reports the proxy and image without a reachable engine", async () => {
    const fake = createFakeBackend();
    const down = { ...fake.backend, detect: async () => ({ available: false, reason: "socket missing" }) };
    const harness = await createHarness({ backend: () => down });

    expect(await run(["sandbox", "status"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain(
      "runtime: none (the sandbox VM engine is unreachable at ~/.colima/pi-sandbox/docker.sock: socket missing)",
    );
    expect(harness.stdout()).toContain("proxy: stopped");
    expect(harness.stdout()).toContain("(not built yet)");
  });
});

describe("pi sandbox config", () => {
  it("prints the effective config followed by the source of each key", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { sessions: { host: false } });

    expect(await run(["sandbox", "config"], harness.deps)).toBe(0);

    const output = harness.stdout();
    const json = output.slice(0, output.indexOf("\n# "));

    expect(JSON.parse(json).sessions.host).toBe(false);
    expect(output).toContain("# sessions.host: config\n");
    expect(output).toContain("# mounts.autoOverlays: default\n");
    expect(JSON.parse(json).image.reference).toBeUndefined();
  });

  it("prints config and sources as one JSON object with --json", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "config", "--json"], harness.deps)).toBe(0);

    const parsed = JSON.parse(harness.stdout()) as {
      config: { sessions: { host: boolean } };
      sources: Record<string, string>;
    };

    expect(parsed.config.sessions.host).toBe(true);
    expect(parsed.sources["sessions.host"]).toBe("default");
  });

  it("only shows the config and refuses any other option", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "config", "set", "sessions.host", "false"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('pi-sandbox: unknown config option "set"\n');
    expect(harness.stderr()).toContain("  hint: pi sandbox config [--json]");
  });
});

describe("the sweep and pi sandbox reset", () => {
  const orphanOf = async (
    fake: ReturnType<typeof createFakeBackend>,
    repoHash: string,
    launchId = "00000000000000ff",
  ) => {
    await fake.backend.prepareProxyRoute({ hostPort: 3128, repoHash, imageId: "relay" });

    return fake.addContainer({
      name: `pi-sandbox-${repoHash.slice(0, 12)}`,
      labels: { [LABELS.managed]: "true", [LABELS.repoHash]: repoHash, [LABELS.launchId]: launchId },
      state: "running",
      image: "x",
    });
  };

  it("removes the container, relay and network of a repository no live launch uses", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const orphan = "b".repeat(64);
    const id = await orphanOf(fake, orphan);

    fake.addContainer({ name: "unrelated", labels: {}, state: "running", image: "x" });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.relays.has(orphan)).toBe(false);
    expect(fake.networks.has(`pi-sandbox-${orphan.slice(0, 12)}`)).toBe(false);
    expect(harness.stoppedProxies).toContain(orphan);
    expect(harness.stdout()).toContain(`removed container pi-sandbox-${orphan.slice(0, 12)} (${id})\n`);
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
    expect(harness.stoppedProxies).toEqual([]);
    expect(fake.containers.has(id)).toBe(true);
    expect(fake.relays.has(repo)).toBe(true);
  });

  it("forgets a repository whose root no longer exists, with its state and volumes", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const gone = await tempDir("gone-repo");
    const hash = sha256Hex(gone);
    const files = stateLayout(harness.stateDir).repo(hash);

    await harness.writeJson(files.record, { root: gone });

    await fake.backend.ensureVolume("pi-sandbox-agent-gone", {
      [LABELS.repoHash]: hash,
      [LABELS.repoRoot]: gone,
    });

    await rm(gone, { recursive: true, force: true });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(await readFile(files.record, "utf8").catch(() => undefined)).toBeUndefined();
    expect(fake.volumes.has("pi-sandbox-agent-gone")).toBe(false);
    expect(harness.stdout()).toContain(`forgot ${gone}, which no longer exists\n`);
  });

  it("removes the dangling sandbox images no container uses and keeps the current base, images in use and foreign ones", async () => {
    const fake = createFakeBackend({ localImages: { "foreign:1": "sha256:foreign" } });
    const harness = await createHarness({ backend: () => fake.backend });
    const context = await tempDir("gc-images");
    const build = (tag: string) => fake.backend.buildImage(context, tag);
    const dangling = await build("pi-sandbox-layer:old");
    const used = await build("pi-sandbox-layer:used");
    const current = await build("pi-sandbox:base");

    fake.ageImages(2 * 60 * 60);

    await build("pi-sandbox-layer:old");

    await build("pi-sandbox-layer:used");

    await build("pi-sandbox:base");

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

  it("leaves the daily collection due when it ran without an engine, as under pi sandbox stop", async () => {
    const harness = await createHarness({ backend: () => createFakeBackend().backend });

    expect(await run(["sandbox", "stop"], harness.deps)).toBe(0);
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

  it("refuses reset while a session of the repository runs, names the count and removes nothing", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);
    const id = await orphanOf(fake, repo);
    const launch = { ...(await processMark()), repoHash: repo, startedAt: 1 };

    await registerLaunch(harness.stateDir, { ...launch, launchId: "00000000000000a1" });

    await registerLaunch(harness.stateDir, { ...launch, launchId: "00000000000000a2" });

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`2 sessions are running in ${harness.repoRoot}`);
    expect(harness.stderr()).toContain("exit them, then run pi sandbox reset again");
    expect(fake.containers.has(id)).toBe(true);
    expect(fake.relays.has(repo)).toBe(true);
    expect(harness.stoppedProxies).toEqual([]);
  });

  it("removes this repository's sandbox and proxy on reset once no session runs", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const repo = sha256Hex(harness.repoRoot);
    const id = await orphanOf(fake, repo);
    const token = stateLayout(harness.stateDir).repo(repo).proxy.token;

    await mkdir(join(token, ".."), { recursive: true });

    await writeFile(token, "f".repeat(64));

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(fake.containers.has(id)).toBe(false);
    expect(fake.relays.has(repo)).toBe(false);
    expect(harness.stoppedProxies).toEqual([repo]);
    expect(await readFile(token, "utf8").catch(() => undefined)).toBeUndefined();
  });

  const tokenOf = async (stateDir: string, repo: string) => {
    const token = stateLayout(stateDir).repo(repo).proxy.token;

    await mkdir(join(token, ".."), { recursive: true });

    await writeFile(token, "f".repeat(64));

    return token;
  };

  it("runs the host side of the sweep when the VM is stopped", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const repo = "c".repeat(64);
    const token = await tokenOf(harness.stateDir, repo);

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(harness.stoppedProxies).toEqual([repo]);
    expect(await readFile(token, "utf8").catch(() => undefined)).toBeUndefined();
    expect(harness.stderr()).not.toContain("unreachable");
  });

  it("runs the host-side part of reset when the VM is stopped and says the engine step was skipped", async () => {
    const harness = await createHarness({ backend: () => unreachable(createFakeBackend().backend) });
    const repo = sha256Hex(harness.repoRoot);
    const token = await tokenOf(harness.stateDir, repo);

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(harness.stoppedProxies).toEqual([repo]);
    expect(await readFile(token, "utf8").catch(() => undefined)).toBeUndefined();
    expect(harness.stdout()).toContain(
      "the sandbox VM is not running, so the engine step was skipped; run colima start --profile pi-sandbox --activate=false, then pi sandbox reset again to remove the container and volumes\n",
    );
    expect(harness.stdout()).not.toContain("no sandbox for");
  });

  it("removes this folder's container and its agent volume", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [agent = ""] = repoVolumes({
      workspace: { cwd: harness.repoRoot, repoRoot: harness.repoRoot, isGitRepo: true },
      config: sandboxConfig(),
      uid: harness.deps.uid,
    });

    expect(fake.volumes.has(agent)).toBe(true);
    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(agent)).toBe(false);
    expect(harness.stdout()).toContain(`removed volume ${agent}\n`);
  });

  it("names only volumes it removed on reset, and keeps one a container still mounts", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const labels = { [LABELS.repoHash]: sha256Hex(harness.repoRoot), [LABELS.repoRoot]: harness.repoRoot };

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(`no sandbox for ${harness.repoRoot}\n`);

    await fake.backend.ensureVolume("pi-sandbox-cache-held", labels);

    const holder = fake.addContainer({ name: "holder", labels: {}, state: "running", image: "x" });
    const entry = fake.containers.get(holder);

    if (entry !== undefined) {
      entry.spec = { mounts: [{ kind: "volume", source: "pi-sandbox-cache-held", target: "/x" }] } as never;
    }

    expect(await run(["sandbox", "reset"], harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-cache-held")).toBe(true);
    expect(harness.stdout()).toContain(
      "kept volume pi-sandbox-cache-held: a container still mounts it, run pi sandbox reset again\n",
    );
  });

  it("removes a volume whose repository no longer exists on disk", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const gone = await tempDir("gone-repo");

    await fake.backend.ensureVolume("pi-sandbox-agent-gone", {
      [LABELS.repoHash]: sha256Hex(gone),
      [LABELS.repoRoot]: gone,
    });

    await rm(gone, { recursive: true, force: true });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-gone")).toBe(false);
    expect(harness.stdout()).toContain("removed volume pi-sandbox-agent-gone\n");
  });

  it("keeps the volumes of a repository that still exists after its container is removed", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [agent = ""] = repoVolumes({
      workspace: { cwd: harness.repoRoot, repoRoot: harness.repoRoot, isGitRepo: true },
      config: sandboxConfig(),
      uid: harness.deps.uid,
    });

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.containers.size).toBe(0);
    expect(fake.volumes.has(agent)).toBe(true);
    expect(harness.stdout()).not.toContain("removed volume");
  });

  it("keeps a volume without a repository label", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await fake.backend.ensureVolume("pi-sandbox-agent-unlabelled");

    expect(await sweepNow(harness.deps)).toBe(0);
    expect(fake.volumes.has("pi-sandbox-agent-unlabelled")).toBe(true);
  });
});

describe("pi sandbox help and version", () => {
  it("prints the launcher version from the package manifest", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "--version"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(`${await packageVersion()}\n`);
  });

  it("prints usage for help and for a bare pi sandbox", async () => {
    const harness = await createHarness();

    expect(await run(["sandbox", "help"], harness.deps)).toBe(0);
    expect(await run(["sandbox"], harness.deps)).toBe(0);
    expect(harness.stdout().match(/pi sandbox doctor/g)).toHaveLength(2);
    expect(harness.stdout()).not.toContain("pi sandbox gc");
    expect(harness.stdout()).toContain("pi sandbox reset  ");
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

    await run(["sandbox", "help"], harness.deps);

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
