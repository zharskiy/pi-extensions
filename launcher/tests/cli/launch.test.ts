import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS } from "../../backend/index.ts";
import { openContext } from "../../cli/context.ts";
import { run } from "../../cli/index.ts";
import { LauncherError, sha256Hex } from "../../shared/index.ts";
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

const PREPARING = "preparing pi sandbox, one time";

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
    expect(occurrences(harness.stderr(), "pi-sandbox: build: Step 1/1")).toBe(1);
    expect(fake.builds).toHaveLength(1);

    const packs = harness.calls.filter((call) => call.file === "npm").length;

    expect(await run(["chat", "hello"], harness.deps)).toBe(3);
    expect(occurrences(harness.stderr(), PREPARING)).toBe(1);
    expect(fake.builds).toHaveLength(1);
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
      { hostPort: 3128, repoHash: sha256Hex(harness.repoRoot), imageId: container?.spec?.image },
    ]);
    expect(container?.spec?.network).toEqual({
      kind: "internal",
      name: `pi-sandbox-${sha256Hex(harness.repoRoot).slice(0, 12)}`,
    });

    expect(mounts).toContainEqual({
      source: harness.repoRoot,
      target: harness.repoRoot,
      readOnly: false,
      kind: "bind",
    });
    expect(mounts.some((mount) => mount.target === "/etc/pi-sandbox/ca.pem")).toBe(true);
    expect(container?.spec?.env.HTTPS_PROXY).toMatch(
      /^http:\/\/pi-sandbox:[0-9a-f]{64}@pi-sandbox-proxy:3128$/,
    );
    expect(container?.spec?.env.HTTP_PROXY).toBe(container?.spec?.env.HTTPS_PROXY);
    expect(container?.spec?.env.NODE_EXTRA_CA_CERTS).toBe("/etc/pi-sandbox/ca.pem");
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
        PI_SANDBOX_LAUNCH_ID: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
      {
        TERM: "xterm-kitty",
        TERM_PROGRAM: "second",
        PI_SANDBOX_LAUNCH_ID: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    ]);
    expect(fake.created).toHaveLength(2);
    expect(new Set(fake.created.map((created) => created.spec?.labels[LABELS.launchId])).size).toBe(2);
    expect(fake.containers.size).toBe(0);
  });

  it("mounts the trust bundle read-only when a credential rule is configured", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      credentials: {
        rules: [
          { id: "llm", host: "llm.example.com", placeholder: "pi-sandbox-llm", secret: { env: "LLM_KEY" } },
        ],
      },
    });

    await run([], harness.deps);

    const [container] = fake.created;

    expect(container?.spec?.env.NODE_EXTRA_CA_CERTS).toBe("/etc/pi-sandbox/ca.pem");
    expect(container?.spec?.env.PI_SANDBOX_TRUST_HASH).toBe("trust-hash");
    expect(container?.spec?.mounts).toContainEqual({
      source: harness.trustPem,
      target: "/etc/pi-sandbox/ca.pem",
      readOnly: true,
      kind: "bind",
    });
  });

  it("creates the container from the built image id and keeps the reference in a label", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await run([], harness.deps);

    const [container] = fake.created;

    expect(container?.spec?.image).toBe("sha256:image-built-1");
    expect(container?.spec?.labels[LABELS.imageReference]).toBe("pi-sandbox-base:local");
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
      `pi-sandbox: ${harness.deps.home} would mount ${harness.deps.home} into the sandbox`,
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
      "pi-sandbox: the sandbox VM engine is unreachable at ~/.colima/pi-sandbox/docker.sock",
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
          throw new LauncherError("the pi-sandbox egress proxy did not become healthy", "see proxy.log");
        },
      },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("the egress proxy could not start, refusing to run without it");
    expect(harness.stderr()).toContain("  hint: see proxy.log");
    expect(fake.containers.size).toBe(0);
    expect(fake.execs).toHaveLength(0);
  });

  it("refuses a folder outside the workspace roots before any discovery", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      workspaceRoots: { roots: [join(harness.root, "elsewhere")] },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(`${harness.repoRoot} is outside the allowed workspace roots`);
    expect(harness.calls.filter((call) => call.file === "git")).toEqual([]);
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
    expect(context.workspace.nested).toBeUndefined();
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
      `pi-sandbox: warning: running ${call?.file} on the host, outside the sandbox`,
    );
  });
});
