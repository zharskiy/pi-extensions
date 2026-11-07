import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { LauncherError, sha256Hex } from "../../shared/index.ts";
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

const PREPARING = "preparing pi sandbox, one time";

const occurrences = (text: string, line: string) => text.split("\n").filter((entry) => entry === line).length;

const writeScript = async (dir: string, body: string) => {
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "pi"), `#!/bin/sh\n${body}\n`);

  await chmod(join(dir, "pi"), 0o755);

  return join(dir, "pi");
};

describe("pi [args]", () => {
  it("prepares once on the cold path, then reuses the container without image work", async () => {
    const fake = createFakeBackend({ exec: (spec) => (spec.command.includes("pi") ? 3 : 0) });
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    expect(await run(["--model", "x"], harness.deps)).toBe(3);
    expect(occurrences(harness.stderr(), PREPARING)).toBe(1);
    expect(fake.builds).toHaveLength(1);

    const packs = harness.calls.filter((call) => call.file === "npm").length;

    expect(await run(["chat", "hello"], harness.deps)).toBe(3);
    expect(occurrences(harness.stderr(), PREPARING)).toBe(1);
    expect(fake.builds).toHaveLength(1);
    expect(harness.calls.filter((call) => call.file === "npm")).toHaveLength(packs);
    expect(fake.containers.size).toBe(1);

    const last = fake.execs.findLast((exec) => exec.spec.command.includes("pi"))?.spec;

    expect(last?.command.slice(-3)).toEqual(["pi", "chat", "hello"]);
    expect(last?.workdir).toBe(harness.cwd);
  });

  it("mounts the repository at its host path, routes through the proxy and leaves out the CA without a gateway", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];
    const mounts = container?.spec?.mounts ?? [];

    expect(fake.routes).toEqual([{ hostPort: 3128, policyHash: "policy", imageId: container?.spec?.image }]);
    expect(container?.spec?.network).toEqual({
      kind: "internal",
      name: `pi-sandbox-${sha256Hex(harness.repoRoot).slice(0, 12)}`,
    });
    expect(container?.spec?.labels["pi-sandbox.proxy-policy-hash"]).toBe("policy");

    expect(mounts).toContainEqual({
      source: harness.repoRoot,
      target: harness.repoRoot,
      readOnly: false,
      kind: "bind",
    });
    expect(mounts.some((mount) => mount.target === "/etc/pi-sandbox/ca.pem")).toBe(false);
    expect(container?.spec?.env.HTTPS_PROXY).toMatch(/^http:\/\/pi-sandbox:[0-9a-f]{64}@10\.89\.0\.2:3128$/);
    expect(container?.spec?.env.HTTP_PROXY).toBe(container?.spec?.env.HTTPS_PROXY);
    expect(container?.spec?.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
  });

  it("passes the terminal variables to pi's exec, not the container, and reuses it from another terminal", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend], env: { TERM_PROGRAM: "first" } });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    harness.deps.env.TERM_PROGRAM = "second";

    harness.deps.env.TERM = "xterm-kitty";

    await run([], harness.deps);

    const piExecs = fake.execs.filter((exec) => exec.spec.command.includes("pi"));

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
    expect([...fake.containers.keys()]).toEqual([container?.summary.id]);
  });

  it("mounts the trust bundle read-only when a gateway is configured", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await harness.writeJson(harness.userConfigFile, {
      gateway: {
        url: "https://gateway.example.com",
        authHeader: "x-api-key",
        placeholder: "pi-sandbox-placeholder",
        providers: [{ id: "gateway", apiKind: "example-messages" }],
      },
    });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    expect(container?.spec?.env.NODE_EXTRA_CA_CERTS).toBe("/etc/pi-sandbox/ca.pem");
    expect(container?.spec?.env.PI_SANDBOX_TRUST_HASH).toBe("trust-hash");
    expect(container?.spec?.mounts).toContainEqual({
      source: harness.trustPem,
      target: "/etc/pi-sandbox/ca.pem",
      readOnly: true,
      kind: "bind",
    });
  });

  it("reuses the packed extensions tarball while the version and HEAD are unchanged", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    await harness.writeJson(harness.userConfigFile, { resources: { cpus: 2 } });

    await run([], harness.deps);

    expect(occurrences(harness.stderr(), PREPARING)).toBe(2);
    expect(harness.calls.filter((call) => call.file === "npm")).toHaveLength(1);
  });

  it("creates the container from the built image id and keeps the reference in a label", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run([], harness.deps);

    const [container] = [...fake.containers.values()];

    expect(container?.spec?.image).toBe("sha256:image-built-1");
    expect(container?.spec?.labels["pi-sandbox.image-reference"]).toMatch(/^ghcr\.io\/zharskiy\/pi-sandbox:/);
  });

  it("refuses a repository rooted at the home directory before touching the backend", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      respond: (call) =>
        call.file === "git" && call.args[1] === "--show-toplevel"
          ? { stdout: `${harness.deps.home}\n${harness.deps.home}/.git\n` }
          : undefined,
    });

    await mkdir(join(harness.deps.home, ".git"), { recursive: true });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pi-sandbox: ${harness.deps.home} would mount ${harness.deps.home} into the sandbox`,
    );
    expect(harness.stderr()).toContain("  hint: run pi inside a project directory");
    expect(fake.containers.size).toBe(0);
    expect(fake.builds).toHaveLength(0);
  });

  it("passes pi --version through to pi inside", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await run(["--version"], harness.deps);

    expect(fake.execs.findLast((exec) => exec.spec.command.includes("pi"))?.spec.command.slice(-2)).toEqual([
      "pi",
      "--version",
    ]);
  });

  it("refuses when no backend is available", async () => {
    const fake = createFakeBackend();
    const down = { ...fake.backend, detect: async () => ({ available: false, reason: "socket missing" }) };
    const harness = await harnessWith({ adapters: () => [down] });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("pi-sandbox: no sandbox backend available: colima (socket missing)");
    expect(harness.stderr()).toContain("  hint: ");
    expect(harness.stderr()).toContain("pi --no-sandbox");
  });

  it("fails closed when the proxy cannot start", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({
      adapters: () => [fake.backend],
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

  it("skips the proxy when nothing may leave the container", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({
      adapters: () => [fake.backend],
      proxy: {
        ensure: async () => {
          throw new Error("must not start");
        },
      },
    });

    await harness.writeJson(harness.userConfigFile, { egress: { allow: [] } });

    expect(await run([], harness.deps)).toBe(0);

    const [container] = [...fake.containers.values()];

    expect(container?.spec?.network).toEqual({ kind: "none" });
    expect(container?.spec?.env.HTTPS_PROXY).toBeUndefined();
  });

  it("refuses outside the workspace roots and warns when the policy says warn", async () => {
    const fake = createFakeBackend();
    const harness = await harnessWith({ adapters: () => [fake.backend] });

    await harness.writeJson(harness.policyFile, {
      workspaceRoots: { roots: [join(harness.root, "elsewhere")], outside: "refuse" },
    });

    expect(await run([], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain("is outside the allowed workspace roots");
    expect(fake.execs).toHaveLength(0);

    await harness.writeJson(harness.policyFile, {
      workspaceRoots: { roots: [join(harness.root, "elsewhere")], outside: "warn" },
    });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      `pi-sandbox: warning: ${harness.repoRoot} is outside the workspace roots`,
    );
  });

  it("refuses --no-sandbox under fallback refuse and names the layer that set it", async () => {
    const harness = await harnessWith();

    await harness.writeJson(harness.policyFile, { fallback: "refuse" });

    expect(await run(["--no-sandbox"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain('--no-sandbox is refused: fallback is "refuse", set by policy');
  });

  it("runs host pi from PATH under fallback host, skipping the launcher's own wrapper", async () => {
    const harness = await harnessWith();
    const wrapperDir = join(harness.root, "local-bin");
    const hostDir = join(harness.root, "host-bin");

    await writeScript(wrapperDir, 'exec node "/checkout/launcher/bin/pi-sandbox-dev.js" "$@"');

    const hostPi = await writeScript(hostDir, "echo host pi");

    harness.deps.env.PATH = `${wrapperDir}:${hostDir}`;

    expect(await run(["--no-sandbox", "-p", "hi"], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      `pi-sandbox: warning: running ${hostPi} on the host, outside the sandbox`,
    );

    const call = harness.calls.find((entry) => entry.interactive);

    expect(call?.file).toBe(hostPi);
    expect(call?.args).toEqual(["-p", "hi"]);
  });
});
