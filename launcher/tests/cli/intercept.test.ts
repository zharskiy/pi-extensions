import { mkdir, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import {
  createFakeBackend,
  createHarness,
  piArgsOf,
  piSessions,
  writeManagedPi,
  writePathPi,
} from "./harness.ts";

const hostPiRuns = (harness: Awaited<ReturnType<typeof createHarness>>) =>
  harness.calls.filter((entry) => entry.interactive).map((entry) => entry.args.slice(1));

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
      "git://example.com/acme/ext",
      "git@github.com:acme/ext",
    ];

    expect(await Promise.all(sources.map((source) => run(["install", source], harness.deps)))).toEqual(
      sources.map(() => 1),
    );
    expect(hostPiRuns(harness)).toEqual([]);
    sources.forEach((source) => {
      expect(harness.stderr()).toContain(
        `pi-sandbox: ${source} lies in the repository, which the sandbox can rewrite; not installed on the host\n`,
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

    expect(await run(["install", "./tools/ext"], workspace.deps)).toBe(1);
    expect([...hostPiRuns(harness), ...hostPiRuns(workspace)]).toEqual([]);
    expect(await readdir(harness.hostAgentDir).catch(() => [])).toEqual([]);
    expect(harness.stderr()).toContain(
      "pi-sandbox: ../ext lies in the repository, which the sandbox can rewrite; not installed on the host\n",
    );
    expect(harness.stderr()).toContain(
      `pi-sandbox: ${link} lies in the repository, which the sandbox can rewrite; not installed on the host\n`,
    );
    expect(harness.stderr()).toContain(
      "pi-sandbox: ext lies in the repository, which the sandbox can rewrite; not installed on the host\n",
    );
    expect(harness.stderr()).toContain(
      `pi-sandbox: file://${join(harness.repoRoot, "ext")} lies in the repository, which the sandbox can rewrite; not installed on the host\n`,
    );
    expect(workspace.stderr()).toContain(
      "pi-sandbox: ./tools/ext lies in the repository, which the sandbox can rewrite; not installed on the host\n",
    );
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

    expect(call?.file).toBe(process.execPath);
    expect(call?.args.slice(1)).toEqual(["mcp", "add", "docs", "--url", "https://docs.example.test/mcp"]);
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
    expect(call?.args.slice(1)).toEqual(["mcp", "login", "docs"]);
    expect(call?.options.env).toEqual({ PI_CODING_AGENT_DIR: harness.hostAgentDir });
    expect(call?.options.cwd?.startsWith(harness.repoRoot)).toBe(false);
    expect(await readdir(call?.options.cwd ?? "").catch(() => "removed")).toBe("removed");
  });

  it("passes login and logout with every flag to the host pi", async () => {
    const harness = await createHarness({ backend: noBackend });

    expect(await run(["mcp", "login", "docs", "--timeout", "30", "-l"], harness.deps)).toBe(0);
    expect(await run(["mcp", "logout", "docs"], harness.deps)).toBe(0);
    expect(harness.calls.filter((entry) => entry.interactive).map((entry) => entry.args.slice(1))).toEqual([
      ["mcp", "login", "docs", "--timeout", "30", "-l"],
      ["mcp", "logout", "docs"],
    ]);
  });
});

describe("pi update", () => {
  it("prints that pi follows the launcher for a bare pi update", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new Error("the backend must not be used");
      },
    });

    expect(await run(["update"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(
      "pi follows the launcher; update it with npm install -g pi-extensions-mz\n",
    );
  });

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

  it("runs a PATH pi's own update and says the sandbox keeps the pi next to the launcher", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new Error("the backend must not be used");
      },
    });
    const onPath = await writePathPi(join(harness.root, "brew"), "1.7.0");

    harness.deps.env.PATH = onPath.bin;

    expect(await run(["update"], harness.deps)).toBe(0);
    expect(harness.calls.filter((call) => call.interactive).map((call) => [call.file, ...call.args])).toEqual(
      [[onPath.pi, "update"]],
    );
    expect(harness.stderr()).toBe(
      `pi-sandbox: the sandbox follows pi ${await testedPiVersion()} next to the launcher, not ${onPath.pi}; update it with npm install -g pi-extensions-mz\n`,
    );
  });

  it("treats pi update pi, self and --self as the bare self-update", async () => {
    const harness = await createHarness({
      backend: () => {
        throw new Error("the backend must not be used");
      },
    });

    expect(await run(["update", "pi"], harness.deps)).toBe(0);
    expect(await run(["update", "self"], harness.deps)).toBe(0);
    expect(await run(["update", "--self"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(
      "pi follows the launcher; update it with npm install -g pi-extensions-mz\n".repeat(3),
    );
  });

  it("runs pi update --extensions inside the sandbox", async () => {
    const fake = createFakeBackend();
    const harness = await createHarness({ backend: () => fake.backend });

    expect(await run(["update", "--extensions"], harness.deps)).toBe(0);
    expect(piSessions(fake).map(piArgsOf)).toEqual([["update", "--extensions"]]);
  });
});
