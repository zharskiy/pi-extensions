import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { openContext } from "../../cli/context.ts";
import { run } from "../../cli/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { FAKE_NETWORK } from "../support/fake-backend.ts";
import {
  createFakeBackend,
  createHarness,
  holdLaunch,
  isPiSession,
  piArgsOf,
  piSession,
  piSessions,
  unreachable,
} from "./harness.ts";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const PREPARING = "preparing the sandbox, one time";

const occurrences = (text: string, line: string) => text.split("\n").filter((entry) => entry === line).length;

const writeScript = async (dir: string, body: string) => {
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "pi"), `#!/bin/sh\n${body}\n`);

  await chmod(join(dir, "pi"), 0o755);

  return join(dir, "pi");
};

describe("pi [args]", () => {
  it("prepares once on the cold path, streaming the build steps, then starts again without image work", async () => {
    const fake = createFakeBackend({ exec: (spec) => (isPiSession(spec) ? 3 : 0) });
    const harness = await createHarness({ backend: () => fake.backend });

    expect(await run(["--model", "x"], harness.deps)).toBe(3);
    expect(occurrences(harness.stderr(), PREPARING)).toBe(1);
    expect(occurrences(harness.stderr(), "pinata: build: Step 1/1")).toBe(2);
    expect(fake.builds.map((build) => build.tag)).toEqual([
      "pinata-base:local",
      expect.stringMatching(/^pinata-layer:[0-9a-f]{12}$/),
    ]);

    const packs = harness.calls.filter((call) => call.file === "npm").length;

    expect(await run(["chat", "hello"], harness.deps)).toBe(3);
    expect(occurrences(harness.stderr(), PREPARING)).toBe(1);
    expect(fake.builds).toHaveLength(2);
    expect(harness.calls.filter((call) => call.file === "npm")).toHaveLength(packs);
    expect(fake.containers.size).toBe(0);

    const last = piSession(fake)?.spec;

    expect(last?.command.slice(-3)).toEqual(["pi", "chat", "hello"]);
    expect(last?.command).toContain(harness.cwd);
  });

  it("mounts the repository at its host path, routes through the proxy and trusts the launcher CA without a credential rule, for the denial page", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = fake.created;
    const mounts = container?.spec?.mounts ?? [];

    expect(fake.routes).toEqual([
      {
        hostPort: 3128,
        imageId: container?.spec?.image,
        preamble: expect.stringMatching(/^PINATA [0-9a-f]{64}$/),
      },
    ]);
    expect(container?.spec?.network).toEqual({
      kind: "internal",
      name: FAKE_NETWORK,
    });

    expect(mounts).toContainEqual({
      source: harness.repoRoot,
      target: harness.repoRoot,
      readOnly: false,
      kind: "bind",
    });
    expect(mounts.some((mount) => mount.target.startsWith("/etc/ssl"))).toBe(false);
    expect(container?.spec?.env.HTTPS_PROXY).toBe("http://pinata-proxy:3128");
    expect(container?.spec?.env.HTTP_PROXY).toBe(container?.spec?.env.HTTPS_PROXY);
    expect(container?.spec?.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
  });

  it("passes the terminal variables to pi's exec, not the container, and gives each launch its own container", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend, env: { TERM_PROGRAM: "first" } });

    await holdLaunch(harness);

    await run([], harness.deps);

    const [container] = fake.created;

    harness.deps.env.TERM_PROGRAM = "second";

    harness.deps.env.TERM = "xterm-kitty";

    await run([], harness.deps);

    const piExecs = piSessions(fake);

    expect(container?.spec?.env.TERM).toBeUndefined();
    expect(container?.spec?.env.TERM_PROGRAM).toBeUndefined();
    expect(piExecs.map((exec) => exec.spec.env)).toEqual([
      {
        TERM: "xterm-256color",
        TERM_PROGRAM: "first",
        PINATA_LAUNCH_ID: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
      {
        TERM: "xterm-kitty",
        TERM_PROGRAM: "second",
        PINATA_LAUNCH_ID: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
    expect(fake.created).toHaveLength(2);
    expect(new Set(fake.created.map((created) => created.spec?.labels[LABELS.launchId])).size).toBe(2);
    expect(fake.containers.size).toBe(0);
  });

  it("bakes the proxy CA into the layer and mounts no trust bundle when a credential rule is configured", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      credentials: {
        rules: [
          { id: "llm", host: "llm.example.com", placeholder: "pinata-llm", secret: { env: "LLM_KEY" } },
        ],
      },
    });

    await run([], harness.deps);

    const [container] = fake.created;

    const layerFiles = Object.keys(fake.builds.at(-1)?.files ?? {});

    expect(container?.spec?.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(container?.spec?.env).not.toHaveProperty("PINATA_TRUST_HASH");
    expect(container?.spec?.mounts.some((mount) => mount.source.includes("trust"))).toBe(false);
    expect(layerFiles.filter((name) => name.startsWith("ca/proxy-"))).toHaveLength(1);
  });

  it("creates the container from the built layer id", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = fake.created;

    expect(container?.spec?.image).toBe("sha256:image-built-2");
  });

  it("refuses a repository rooted at the home directory before touching the backend", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      respond: (call) =>
        call.file === "git" && call.args.includes("--show-toplevel")
          ? { stdout: `${harness.deps.home}\n${harness.deps.home}/.git\n` }
          : undefined,
    });

    await mkdir(join(harness.deps.home, ".git"), { recursive: true });

    harness.deps.cwd = harness.deps.home;

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: pi may not start in ${harness.deps.home}, a protected folder`,
    );
    expect(harness.stderr()).toContain("  hint: run pi inside a project directory");
    expect(fake.containers.size).toBe(0);
    expect(fake.builds).toHaveLength(0);
  });

  it("passes pi list through to pi inside", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run(["list"], harness.deps);

    expect(piArgsOf(piSession(fake))).toEqual(["list"]);
  });

  it("refuses when no backend is available", async () => {
    const down = unreachable(createFakeBackend().backend);
    const harness = await createHarness({ backend: () => down });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      "pinata: the sandbox VM engine is unreachable at ~/.colima/pinata/docker.sock",
    );
    expect(harness.stderr()).toContain("  hint: ");
    expect(harness.stderr()).not.toContain("--no-sandbox");
  });

  it("fails closed when the proxy cannot start", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({
      backend: () => fake.backend,
      proxy: {
        ensure: async () => {
          throw new LauncherError("the pinata egress proxy did not become healthy", "see proxy.log");
        },
      },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("the egress proxy could not start, refusing to run without it");
    expect(harness.stderr()).toContain("  hint: see proxy.log");
    expect(fake.containers.size).toBe(0);
    expect(fake.execs).toHaveLength(0);
  });

  it("refuses a folder outside the workspace root before any discovery", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const elsewhere = join(harness.root, "elsewhere");

    await mkdir(elsewhere);

    await harness.writeJson(harness.userConfigFile, { workspaceRoot: elsewhere });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      [
        `pinata: ${harness.repoRoot} is outside the workspace root (workspaceRoot: ${elsewhere})`,
        "  hint: start pi inside it, or point workspaceRoot at a folder that holds the project",
      ].join("\n"),
    );
    expect(harness.calls.filter((call) => call.file === "git")).toEqual([]);
    expect(fake.execs).toHaveLength(0);
  });

  it("refuses a host launch outside the workspace root", async () => {
    const harness = await createHarness();
    const elsewhere = join(harness.root, "elsewhere");

    await mkdir(elsewhere);

    await harness.writeJson(harness.userConfigFile, { workspaceRoot: elsewhere });

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`pinata: ${harness.repoRoot} is outside the workspace root`);
    expect(harness.calls.filter((call) => call.interactive)).toEqual([]);
  });

  it.each([
    ["a sandbox launch", []],
    ["a host launch", ["--no-sandbox"]],
  ])("refuses %s under a workspace root that does not exist, saying so", async (_name, args) => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const gone = join(harness.root, "gone");

    await harness.writeJson(harness.userConfigFile, { workspaceRoot: gone });

    expect(await run(args, harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      [
        `pinata: config: workspaceRoot: ${gone} does not exist`,
        "  hint: create the folder, mount the volume it lives on, or point workspaceRoot at a folder that holds your projects",
      ].join("\n"),
    );
    expect(harness.calls.filter((call) => call.file === "colima" || call.interactive)).toEqual([]);
    expect(fake.execs).toHaveLength(0);
  });

  it("runs a host launch while workspaceRoot is not set, as no VM is involved", async () => {
    const harness = await createHarness({ workspaceRoot: false });

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);
    expect(harness.calls.find((entry) => entry.interactive)?.args).toEqual(["-p", "hi"]);
  });

  it("runs a host launch under a workspace root that holds the home dir, as no VM shares it", async () => {
    const harness = await createHarness();

    await harness.writeJson(harness.userConfigFile, { workspaceRoot: harness.root });

    expect(await run(["--no-sandbox"], harness.deps)).toBe(0);
  });

  it("refuses a sandbox launch while workspaceRoot is not set, before any VM work", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend, workspaceRoot: false });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      [
        "pinata: config: workspaceRoot is not set, so pi has no folder it may start in",
        `  hint: run pinata init, or set workspaceRoot in ${harness.userConfigFile} to the folder that holds your projects`,
      ].join("\n"),
    );
    expect(harness.calls.filter((call) => call.file === "colima" || call.interactive)).toEqual([]);
    expect(fake.execs).toHaveLength(0);
  });

  it.each([
    ["the home dir", (harness: Harness) => harness.deps.home],
    ["a folder that holds the home dir", (harness: Harness) => harness.root],
  ])("refuses %s as the workspace root at launch, before any VM work", async (_name, rootOf) => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });
    const root = rootOf(harness);

    await harness.writeJson(harness.userConfigFile, { workspaceRoot: root });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      [
        `pinata: config: workspaceRoot: ${root} is the home dir or holds it, which would share all of it with the sandbox VM`,
        "  hint: point workspaceRoot at the folder that holds your projects, not at your home or above it",
      ].join("\n"),
    );
    expect(harness.calls.filter((call) => call.file === "colima")).toEqual([]);
    expect(fake.execs).toHaveLength(0);
  });

  it("refuses ~ as the workspace root when it reads the config", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, { workspaceRoot: "~" });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      "pinata: config: workspaceRoot ~ is the home dir, which would share all of it with the sandbox VM",
    );
    expect(harness.calls.filter((call) => call.file === "colima")).toEqual([]);
    expect(fake.execs).toHaveLength(0);
  });

  it("does not walk the home folder for a host command started there", async () => {
    const harness = await createHarness();

    await mkdir(join(harness.deps.home, "project", ".git"), { recursive: true });

    harness.deps.cwd = harness.deps.home;

    const { context } = await openContext(harness.deps, "host");

    expect(context.workspace).toMatchObject({
      cwd: harness.deps.home,
      repoRoot: harness.deps.home,
      isGitRepo: false,
    });
  });

  it("runs the managed pi for --no-sandbox, never a pi on PATH, and says so", async () => {
    const harness = await createHarness();
    const hostDir = join(harness.root, "host-bin");

    await writeScript(hostDir, "echo host pi");

    harness.deps.env.PATH = hostDir;

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);

    const call = harness.calls.find((entry) => entry.interactive);

    expect(call?.file).toBe(join(harness.hostAgentDir, "bin", "pi"));
    expect(call?.args).toEqual(["-p", "hi"]);
    expect(harness.stderr()).toContain(
      `pinata: warning: running ${call?.file} on the host, outside the sandbox`,
    );
  });
});
