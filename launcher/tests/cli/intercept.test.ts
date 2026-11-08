import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecIo, ExecSpec } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { testedPiVersion } from "../../cli/versions.ts";
import { stateLayout } from "../../shared/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { createHarness, writeManagedPi, writePathPi } from "./harness.ts";

type PiAnswer = (args: string[], files: Map<string, string>, workdir: string) => number;

const streamText = (stream: NodeJS.ReadableStream | undefined) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];

    if (stream === undefined) {
      resolve("");

      return;
    }

    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));

    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const volumeBackend = (answer: PiAnswer) => {
  const files = new Map<string, string>();
  const piRuns: string[][] = [];
  const exec = async (spec: ExecSpec, io: ExecIo) => {
    const [first, second, script = "", , path = ""] = spec.command;

    if (first === "cat") {
      const text = files.get(second ?? "");

      io.stdout.write(text ?? "");

      return text === undefined ? 1 : 0;
    }

    if (first === "sh" && script.includes("pi-sandbox-tmp")) {
      files.set(path, await streamText(io.stdin));

      return 0;
    }

    if (spec.command.includes("pi")) {
      const args = spec.command.slice(spec.command.indexOf("pi") + 1);

      piRuns.push(args);

      return answer(args, files, spec.workdir ?? "/");
    }

    return 0;
  };

  return { fake: createFakeBackend({ exec }), files, piRuns };
};

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
  it("runs pi install and pi remove with the host pi in the current directory, without the sandbox", async () => {
    const harness = await createHarness({ backend: noBackend });

    expect(await run(["install", "npm:fresh"], harness.deps)).toBe(0);
    expect(await run(["remove", "npm:old"], harness.deps)).toBe(0);
    expect(hostPiRuns(harness)).toEqual([
      ["install", "npm:fresh"],
      ["remove", "npm:old"],
    ]);
    expect(harness.calls.find((entry) => entry.interactive)?.options).toEqual({ cwd: harness.cwd });
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
    expect(workspace.stderr()).toContain(
      "pi-sandbox: ./tools/ext lies in the repository, which the sandbox can rewrite; not installed on the host\n",
    );
  });

  it("passes a project install with -l straight through", async () => {
    const volume = volumeBackend(() => 0);
    const harness = await createHarness({ backend: () => volume.fake.backend });

    expect(await run(["install", "npm:local", "-l"], harness.deps)).toBe(0);
    expect(volume.piRuns).toEqual([["install", "npm:local", "-l"]]);
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
    expect(call?.options).toEqual({ cwd: harness.cwd });
  });

  it("signs in on the host against a one-server helper dir with only the sanitised server", async () => {
    const harness = await createHarness({ backend: noBackend });

    await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
      mcpServers: {
        docs: {
          url: "https://docs.example.test/mcp",
          headers: { "X-Trace": "on" },
          oauth: { clientId: "pi", scope: "!secret-command" },
        },
        other: { url: "https://other.example.test/mcp" },
      },
    });

    expect(await run(["mcp", "login", "docs"], harness.deps)).toBe(0);

    const helper = stateLayout(harness.stateDir).mcpAuth;
    const call = harness.calls.find((entry) => entry.interactive);

    expect(call?.args.slice(1)).toEqual(["mcp", "login", "docs"]);
    expect(call?.options).toEqual({ cwd: helper, env: { PI_CODING_AGENT_DIR: helper } });
    expect(JSON.parse(await readFile(join(helper, "mcp.json"), "utf8"))).toEqual({
      mcpServers: { docs: { url: "https://docs.example.test/mcp", oauth: { clientId: "pi" } } },
    });
  });

  it("passes login flags such as --timeout to the host pi and leaves unknown flags to the sandbox", async () => {
    const harness = await createHarness({ backend: noBackend });

    await harness.writeJson(join(harness.hostAgentDir, "mcp.json"), {
      mcpServers: { docs: { url: "https://docs.example.test/mcp" } },
    });

    expect(await run(["mcp", "login", "docs", "--timeout", "30", "-l"], harness.deps)).toBe(0);
    expect(await run(["mcp", "login", "--timeout", "45", "docs"], harness.deps)).toBe(0);
    expect(await run(["mcp", "logout", "docs", "--local"], harness.deps)).toBe(0);
    expect(harness.calls.filter((entry) => entry.interactive).map((entry) => entry.args.slice(1))).toEqual([
      ["mcp", "login", "docs", "--timeout", "30"],
      ["mcp", "login", "docs", "--timeout", "45"],
      ["mcp", "logout", "docs"],
    ]);

    await run(["mcp", "login", "docs", "--bogus"], harness.deps);

    expect(harness.calls.filter((entry) => entry.interactive)).toHaveLength(3);
  });

  it("asks before signing in to a server defined only by the repository", async () => {
    const harness = await createHarness({ backend: noBackend });

    await harness.writeJson(join(harness.repoRoot, ".pi", "mcp.json"), {
      mcpServers: { repo: { url: "https://repo.example.test/mcp" } },
    });

    expect(await run(["mcp", "login", "repo"], harness.deps)).toBe(1);
    expect(harness.questions).toEqual([
      expect.stringContaining("mcp repo is defined only in this repository"),
    ]);
    expect(harness.calls.some((entry) => entry.interactive)).toBe(false);

    const confirming = await createHarness({ backend: noBackend, confirm: true });

    await confirming.writeJson(join(confirming.repoRoot, ".pi", "mcp.json"), {
      mcpServers: { repo: { url: "https://repo.example.test/mcp" } },
    });

    expect(await run(["mcp", "login", "repo"], confirming.deps)).toBe(0);
    expect(confirming.calls.some((entry) => entry.interactive)).toBe(true);
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
    const volume = volumeBackend(() => 0);
    const harness = await createHarness({ backend: () => volume.fake.backend });

    expect(await run(["update", "--extensions"], harness.deps)).toBe(0);
    expect(volume.piRuns).toEqual([["update", "--extensions"]]);
  });
});
