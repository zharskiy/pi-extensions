import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathsOf } from "../../cli/deps.ts";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { repoHash, writeRepoRecord } from "../../shared/index.ts";
import {
  createFakeBackend,
  createHarness,
  noHostPiLine,
  piArgsOf,
  piSessions,
  writeManagedPi,
  writePathPi,
} from "./harness.ts";

const hostPiRuns = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.filter((entry) => entry.interactive).map((entry) => entry.args);

const noBackend = () => {
  throw new Error("the backend must not be used");
};

const workspaceRoot = async () => {
  const harness = await createHarness({
    backend: noBackend,
    respond: (call) =>
      call.file === "git" && String(call.options.cwd ?? "").includes("work")
        ? { stdout: `${call.options.cwd}\n.git\n` }
        : undefined,
  });
  const work = join(harness.root, "work");

  await mkdir(join(work, "a", ".git", "hooks"), { recursive: true });

  await mkdir(join(work, "tools", "ext"), { recursive: true });

  return { ...harness, deps: { ...harness.deps, cwd: work } };
};

describe("pi install and pi remove", () => {
  it("runs pi install and pi remove with the host pi from an empty directory, without the sandbox", async () => {
    const harness = await createHarness({ backend: noBackend });

    expect(await run(["install", "npm:fresh"], harness.deps)).toBe(0);
    expect(await run(["remove", "npm:old"], harness.deps)).toBe(0);
    expect(await run(["install", "https://github.com/acme/ext@v1"], harness.deps)).toBe(0);
    expect(await run(["install", "git:git@github.com:acme/ext"], harness.deps)).toBe(0);
    expect(await run(["install", "ssh://git@git.example.test/acme/ext.git"], harness.deps)).toBe(0);
    expect(hostPiRuns(harness)).toEqual([
      ["install", "npm:fresh"],
      ["remove", "npm:old"],
      ["install", "https://github.com/acme/ext@v1"],
      ["install", "git:git@github.com:acme/ext"],
      ["install", "ssh://git@git.example.test/acme/ext.git"],
    ]);

    const cwds = harness.calls.filter((entry) => entry.interactive).map((entry) => entry.options.cwd ?? "");

    expect(cwds.every((cwd) => !cwd.startsWith(harness.repoRoot) && cwd.includes("mcp-login-"))).toBe(true);
    expect(await Promise.all(cwds.map((cwd) => readdir(cwd).catch(() => "removed")))).toEqual(
      cwds.map(() => "removed"),
    );
  });

  it("hands a relative local source outside the repository to the host pi as an absolute path", async () => {
    const harness = await createHarness({ backend: noBackend });
    const ext = join(harness.deps.home, "tools", "ext");

    await mkdir(ext, { recursive: true });

    expect(await run(["remove", "~/tools/ext"], harness.deps)).toBe(0);
    expect(hostPiRuns(harness)).toEqual([["remove", ext]]);
  });

  it("treats every source host pi would read as a path as local, and refuses it inside the repository", async () => {
    const harness = await createHarness({ backend: noBackend });
    const sources = [
      " npm:foo",
      "github:evil",
      "https://example.com",
      "ssh:x",
      "git:x",
      `git:file://${harness.repoRoot}`,
      "git@github.com:acme/ext",
    ];

    expect(await Promise.all(sources.map((source) => run(["install", source], harness.deps)))).toEqual(
      sources.map(() => 1),
    );
    expect(hostPiRuns(harness)).toEqual([]);
    sources.forEach((source) => {
      expect(harness.stderr()).toContain(
        `pi-sandbox: ${source} lies in a git working tree or a sandboxed folder, which a sandbox can rewrite; not installed on the host\n`,
      );
    });
  });

  it("refuses npm specs that name a path or another protocol", async () => {
    const harness = await createHarness({ backend: noBackend });
    const sources = [
      "npm:/opt/ext",
      "npm:file:../ext",
      "npm:link:../ext",
      "npm:foo@file:../ext",
      "npm:./ext",
    ];

    expect(await Promise.all(sources.map((source) => run(["install", source], harness.deps)))).toEqual(
      sources.map(() => 1),
    );
    expect(hostPiRuns(harness)).toEqual([]);
    sources.forEach((source) => {
      expect(harness.stderr()).toContain(
        `pi-sandbox: ${source} is not a plain npm package name and version; not installed on the host\n`,
      );
    });
  });

  it("installs a local source outside the repository on the host", async () => {
    const harness = await createHarness({ backend: noBackend });
    const ext = join(harness.deps.home, "tools", "ext");

    await mkdir(ext, { recursive: true });

    expect(await run(["install", ext], harness.deps)).toBe(0);
    expect(hostPiRuns(harness)).toEqual([["install", ext]]);
  });

  it("refuses to install a package source inside the repository on the host", async () => {
    const harness = await createHarness({ backend: noBackend });
    const link = join(harness.deps.home, "tools", "ext");

    await mkdir(join(harness.repoRoot, "ext"), { recursive: true });

    await mkdir(join(harness.deps.home, "tools"), { recursive: true });

    await symlink(join(harness.repoRoot, "ext"), link);

    expect(await run(["install", "../ext"], harness.deps)).toBe(1);
    expect(await run(["install", link], harness.deps)).toBe(1);
    expect(await run(["install", "ext"], harness.deps)).toBe(1);
    expect(await run(["install", `file://${join(harness.repoRoot, "ext")}`], harness.deps)).toBe(1);

    const workspace = await workspaceRoot();

    await writeRepoRecord(pathsOf(workspace.deps).stateDir, repoHash(workspace.deps.cwd), workspace.deps.cwd);

    expect(await run(["install", "./tools/ext"], workspace.deps)).toBe(1);
    expect([...hostPiRuns(harness), ...hostPiRuns(workspace)]).toEqual([]);
    expect(await readdir(harness.hostAgentDir).catch(() => [])).toEqual(["bin", "install"]);
    expect(harness.stderr()).toContain(
      "pi-sandbox: ../ext lies in a git working tree or a sandboxed folder, which a sandbox can rewrite; not installed on the host\n",
    );
    expect(harness.stderr()).toContain(
      `pi-sandbox: ${link} lies in a git working tree or a sandboxed folder, which a sandbox can rewrite; not installed on the host\n`,
    );
    expect(harness.stderr()).toContain(
      "pi-sandbox: ext lies in a git working tree or a sandboxed folder, which a sandbox can rewrite; not installed on the host\n",
    );
    expect(harness.stderr()).toContain(
      `pi-sandbox: file://${join(harness.repoRoot, "ext")} lies in a git working tree or a sandboxed folder, which a sandbox can rewrite; not installed on the host\n`,
    );
    expect(workspace.stderr()).toContain(
      "pi-sandbox: ./tools/ext lies in a git working tree or a sandboxed folder, which a sandbox can rewrite; not installed on the host\n",
    );
  });

  it("decides by the source path, not the folder pi was started in", async () => {
    const harness = await createHarness({ backend: noBackend });
    const ext = join(harness.deps.home, "tools", "ext");
    const outside = { ...harness.deps, cwd: harness.deps.home };

    await mkdir(ext, { recursive: true });

    expect(await run(["install", "./tools/ext"], outside)).toBe(0);
    expect(await run(["install", join(harness.repoRoot, "ext")], outside)).toBe(1);
    expect(hostPiRuns(harness)).toEqual([["install", ext]]);
  });

  it("ignores a git root no sandbox can hold, such as a home folder kept in git", async () => {
    const harness = await createHarness({ backend: noBackend });
    const ext = join(harness.deps.home, "tools", "ext");

    await mkdir(join(harness.deps.home, ".git"), { recursive: true });

    await mkdir(ext, { recursive: true });

    expect(await run(["install", "~/tools/ext"], { ...harness.deps, cwd: harness.deps.home })).toBe(0);
    expect(hostPiRuns(harness)).toEqual([["install", ext]]);
  });

  it("runs pi uninstall on the host like remove and takes git:// URLs as git sources", async () => {
    const harness = await createHarness({ backend: noBackend });

    expect(await run(["uninstall", "npm:foo"], harness.deps)).toBe(0);
    expect(await run(["install", "git://example.com/acme/ext"], harness.deps)).toBe(0);
    expect(hostPiRuns(harness)).toEqual([
      ["uninstall", "npm:foo"],
      ["install", "git://example.com/acme/ext"],
    ]);
  });

  it("passes a project install with -l straight through", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    expect(await run(["install", "npm:local", "-l"], harness.deps)).toBe(0);
    expect(piSessions(fake).map(piArgsOf)).toEqual([["install", "npm:local", "-l"]]);
    expect(hostPiRuns(harness)).toEqual([]);
  });
});

describe("pi mcp", () => {
  it("runs mcp add and remove with the host pi against the host agent dir", async () => {
    const harness = await createHarness({ backend: noBackend });

    expect(await run(["mcp", "add", "docs", "--url", "https://docs.example.test/mcp"], harness.deps)).toBe(0);

    const call = harness.calls.find((entry) => entry.interactive);

    expect(call?.file).toBe(join(harness.hostAgentDir, "bin", "pi"));
    expect(call?.args).toEqual(["mcp", "add", "docs", "--url", "https://docs.example.test/mcp"]);
    expect(call?.options).toEqual({ cwd: harness.cwd, env: { PI_CODING_AGENT_DIR: harness.hostAgentDir } });
  });

  it("signs in on the host with the host agent dir from an empty directory outside the repository", async () => {
    const harness = await createHarness({ backend: noBackend });
    const runner = harness.deps.runner;
    const seen: string[][] = [];

    harness.deps.runner = {
      ...runner,
      spawnInteractive: async (file, args, options) => {
        seen.push(await readdir(options?.cwd ?? ""));

        return runner.spawnInteractive(file, args, options);
      },
    };

    expect(await run(["mcp", "login", "docs"], harness.deps)).toBe(0);

    const call = harness.calls.find((entry) => entry.interactive);

    expect(seen).toEqual([[]]);
    expect(call?.args).toEqual(["mcp", "login", "docs"]);
    expect(call?.options.env).toEqual({ PI_CODING_AGENT_DIR: harness.hostAgentDir });
    expect(call?.options.cwd?.startsWith(harness.repoRoot)).toBe(false);
    expect(await readdir(call?.options.cwd ?? "").catch(() => "removed")).toBe("removed");
  });

  it("passes login and logout with every flag to the host pi", async () => {
    const harness = await createHarness({ backend: noBackend });

    expect(await run(["mcp", "login", "docs", "--timeout", "30", "-l"], harness.deps)).toBe(0);
    expect(await run(["mcp", "logout", "docs"], harness.deps)).toBe(0);
    expect(harness.calls.filter((entry) => entry.interactive).map((entry) => entry.args)).toEqual([
      ["mcp", "login", "docs", "--timeout", "30", "-l"],
      ["mcp", "logout", "docs"],
    ]);
  });
});

describe("pi update", () => {
  it("runs the managed pi's own update on the host and names the version the sandbox follows", async () => {
    const holder: { agentDir?: string } = {};
    const harness = await createHarness({
      backend: () => {
        throw new Error("the backend must not be used");
      },
      respond: async (call) => {
        if (!call.interactive || holder.agentDir === undefined) {
          return undefined;
        }

        await writeManagedPi(holder.agentDir, "1.7.0");

        return { code: 0 };
      },
    });
    const managed = await writeManagedPi(harness.hostAgentDir, "1.6.0");

    holder.agentDir = harness.hostAgentDir;

    expect(await run(["update"], harness.deps)).toBe(0);
    expect(harness.calls.filter((call) => call.interactive).map((call) => [call.file, ...call.args])).toEqual(
      [[managed.wrapper, "update"]],
    );
    expect(harness.stderr()).toBe("pi-sandbox: the sandbox follows pi 1.7.0 at the next launch\n");
    expect(harness.stdout()).toBe("");
  });

  it("never runs a PATH pi for pi update; without a managed install it prints the missing-pi line", async () => {
    const harness = await createHarness({
      hostPi: false,
      backend: () => {
        throw new Error("the backend must not be used");
      },
    });
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run(["update"], harness.deps)).toBe(1);
    expect(harness.calls.filter((call) => call.interactive)).toEqual([]);
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe(`pi-sandbox: ${noHostPiLine(harness.hostAgentDir)}\n`);
  });

  it("treats pi update pi, self and --self as the bare self-update", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new Error("the backend must not be used");
      },
    });
    const wrapper = join(harness.hostAgentDir, "bin", "pi");

    expect(await run(["update", "pi"], harness.deps)).toBe(0);
    expect(await run(["update", "self"], harness.deps)).toBe(0);
    expect(await run(["update", "--self"], harness.deps)).toBe(0);
    expect(harness.calls.filter((call) => call.interactive).map((call) => [call.file, ...call.args])).toEqual(
      [0, 1, 2].map(() => [wrapper, "update"]),
    );
  });

  it("runs pi update --extensions inside the sandbox", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    expect(await run(["update", "--extensions"], harness.deps)).toBe(0);
    expect(piSessions(fake).map(piArgsOf)).toEqual([["update", "--extensions"]]);
  });
});

const PINNED = `sha256:${"a".repeat(64)}`;

const NO_RESOURCES = ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--offline"];

const hostPiJobs = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.filter((entry) => entry.interactive);

const launched = async (argv: string[]) => {
  const fake = createFakeBackend();
  const harness = await createHarness({ backend: () => fake.backend });
  const code = await run(argv, harness.deps);

  return {
    code,
    inside: piSessions(fake).map(piArgsOf),
    host: hostPiRuns(harness),
    stdout: harness.stdout(),
  };
};

const inTurn = <T>(forms: string[][], each: (argv: string[]) => Promise<T>) =>
  forms.reduce<Promise<T[]>>(async (done, argv) => [...(await done), await each(argv)], Promise.resolve([]));

describe("pi commands that start no session", () => {
  it("prints the pi version the sandbox runs without starting pi or the sandbox", async () => {
    const harness = await createHarness({ backend: noBackend });

    await writeManagedPi(harness.hostAgentDir, "1.6.0");

    expect(await run(["--version"], harness.deps)).toBe(0);
    expect(await run(["-v"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe("1.6.0\n1.6.0\n");
    expect(harness.calls).toEqual([]);
  });

  it("prints the tested pi version when no host pi resolves, as the image build does", async () => {
    const harness = await createHarness({ backend: noBackend, hostPi: false });

    expect(await run(["--version"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(`${await testedPiVersion()}\n`);
  });

  it("asks pi inside a pinned image for its version", async () => {
    const fake = createFakeBackend({ registry: { "registry.example.test/pi-sandbox:1": PINNED } });
    const harness = await createHarness({ backend: () => fake.backend });

    await harness.writeJson(harness.userConfigFile, {
      image: { reference: "registry.example.test/pi-sandbox:1", digest: PINNED },
    });

    expect(await run(["--version"], harness.deps)).toBe(0);
    expect(piSessions(fake).map(piArgsOf)).toEqual([["--version"]]);
  });

  it("runs subcommand help and auth with the host pi from an empty directory against the host agent dir", async () => {
    const harness = await createHarness({ backend: noBackend });
    const forms = [
      ["install", "--help"],
      ["remove", "npm:old", "-h"],
      ["uninstall", "--help"],
      ["update", "--help"],
      ["update", "--extensions", "-h"],
      ["list", "--help"],
      ["config", "-l", "--help"],
      ["mcp"],
      ["mcp", "help"],
      ["mcp", "list", "--help"],
      ["auth"],
      ["auth", "help"],
      ["auth", "login", "provider-x"],
      ["auth", "logout", "provider-x"],
      ["auth", "check", "--provider", "provider-x", "--json"],
      ["auth", "print-api-key", "--provider", "provider-x"],
      ["auth", "print-bearer-token", "--provider", "provider-x", "--min-expiry", "5m"],
    ];

    expect(await inTurn(forms, (argv) => run(argv, harness.deps))).toEqual(forms.map(() => 0));
    expect(hostPiRuns(harness)).toEqual(forms);

    const jobs = hostPiJobs(harness);
    const cwds = jobs.map((entry) => entry.options.cwd ?? "");

    expect(jobs.map((entry) => entry.options.env)).toEqual(
      jobs.map(() => ({ PI_CODING_AGENT_DIR: harness.hostAgentDir })),
    );
    expect(cwds.every((cwd) => !cwd.startsWith(harness.repoRoot) && cwd.includes("mcp-login-"))).toBe(true);
    expect(await Promise.all(cwds.map((cwd) => readdir(cwd).catch(() => "removed")))).toEqual(
      cwds.map(() => "removed"),
    );
  });

  it("runs pi's help and model listing on the host without extensions, package resources or installs", async () => {
    const harness = await createHarness({ backend: noBackend });
    const forms = [["--help"], ["-h"], ["--list-models"], ["--list-models", "fast"]];

    expect(await inTurn(forms, (argv) => run(argv, harness.deps))).toEqual(forms.map(() => 0));
    expect(hostPiRuns(harness)).toEqual(forms.map((argv) => [...argv, ...NO_RESOURCES]));
    expect(hostPiJobs(harness).every((entry) => entry.options.cwd?.includes("mcp-login-"))).toBe(true);
  });

  it("passes the exit code of host pi auth through", async () => {
    const harness = await createHarness({
      backend: noBackend,
      respond: (call) => (call.interactive && call.args.includes("check") ? { code: 2 } : undefined),
    });

    expect(await run(["auth", "check", "--provider", "provider-x"], harness.deps)).toBe(2);
  });

  it("exports a session with the host pi in the cwd, so relative paths resolve there", async () => {
    const harness = await createHarness({ backend: noBackend });

    expect(await run(["--export", "session.jsonl"], harness.deps)).toBe(0);
    expect(await run(["--export", "session.jsonl", "out.html"], harness.deps)).toBe(0);
    expect(hostPiRuns(harness)).toEqual([
      ["--export", "session.jsonl"],
      ["--export", "session.jsonl", "out.html"],
    ]);
    expect(hostPiJobs(harness).map((entry) => entry.options)).toEqual([
      { cwd: harness.cwd, env: { PI_CODING_AGENT_DIR: harness.hostAgentDir } },
      { cwd: harness.cwd, env: { PI_CODING_AGENT_DIR: harness.hostAgentDir } },
    ]);
  });

  it("refuses a host job with the missing-pi line when no managed pi resolves, as pi mcp login does", async () => {
    const harness = await createHarness({ backend: noBackend, hostPi: false });

    expect(await run(["auth", "login", "provider-x"], harness.deps)).toBe(1);
    expect(await run(["--list-models"], harness.deps)).toBe(1);
    expect(hostPiJobs(harness)).toEqual([]);
    expect(harness.stderr()).toBe(`pi-sandbox: ${noHostPiLine(harness.hostAgentDir)}\n`.repeat(2));
  });

  it("lets a subcommand win over a version or help flag, as pi does", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    expect(await run(["auth", "--version"], harness.deps)).toBe(0);
    expect(await run(["install", "--version"], harness.deps)).toBe(0);
    expect(await run(["mcp", "--version"], harness.deps)).toBe(0);
    expect(hostPiRuns(harness)).toEqual([["auth", "--version"]]);
    expect(piSessions(fake).map(piArgsOf)).toEqual([
      ["install", "--version"],
      ["mcp", "--version"],
    ]);
    expect(harness.stdout()).toBe("");
  });

  it("launches the sandbox for flag values, words after --, sessions and the commands that stay inside", async () => {
    const forms = [
      ["--system-prompt", "--version"],
      ["--append-system-prompt", "-h"],
      ["--", "--version"],
      ["--", "--help"],
      ["--export"],
      ["--export", "session.jsonl", "--model", "x"],
      ["--list-models", "--verbose"],
      ["-p", "hello"],
      ["list"],
      ["mcp", "list"],
      ["update", "--all"],
      ["config"],
      ["install", "npm:local", "-l"],
    ];

    expect(await inTurn(forms, launched)).toEqual(
      forms.map((argv) => ({ code: 0, inside: [argv], host: [], stdout: "" })),
    );
  });
});
