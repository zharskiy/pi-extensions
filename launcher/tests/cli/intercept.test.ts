import { mkdir, readFile, symlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecIo, ExecSpec } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { GUEST_PATHS, stateLayout } from "../../shared/index.ts";
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

const SETTINGS = "/home/pi/.pi/agent/settings.json";

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

const LOCAL_SOURCE = /^(\/|\.|~)/;

const storedForm = (source: string, workdir: string) =>
  LOCAL_SOURCE.test(source) ? relative(GUEST_PATHS.agentDir, resolve(workdir, source)) : source;

const volumePackages = (files: Map<string, string>) =>
  (JSON.parse(files.get(SETTINGS) ?? "{}") as { packages?: unknown[] }).packages ?? [];

const recording =
  (packagesAfter: (packages: unknown[], args: string[], workdir: string) => unknown[]): PiAnswer =>
  (args, files, workdir) => {
    const settings = JSON.parse(files.get(SETTINGS) ?? "{}") as Record<string, unknown>;

    files.set(
      SETTINGS,
      JSON.stringify({ ...settings, packages: packagesAfter(volumePackages(files), args, workdir) }),
    );

    return 0;
  };

const installing =
  (code: number): PiAnswer =>
  (args, files, workdir) => {
    const stored = storedForm(args[1] ?? "", workdir);
    const packages = volumePackages(files);
    const next = args[0] === "remove" ? packages.filter((entry) => entry !== stored) : [...packages, stored];

    recording(() => next)(args, files, workdir);

    return code;
  };

const hostSettings = async (harness: { hostAgentDir: string }) =>
  JSON.parse(await readFile(join(harness.hostAgentDir, "settings.json"), "utf8")) as Record<string, unknown>;

describe("pi install and pi remove", () => {
  it("runs inside the sandbox and writes only that package entry to the host settings.json on exit 0", async () => {
    const volume = volumeBackend(installing(0));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), {
      theme: "dark",
      packages: ["npm:old"],
    });

    expect(await run(["install", "npm:fresh"], harness.deps)).toBe(0);
    expect(volume.piRuns).toEqual([["install", "npm:fresh"]]);
    expect(await hostSettings(harness)).toEqual({ theme: "dark", packages: ["npm:old", "npm:fresh"] });

    expect(await run(["remove", "npm:old"], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({ theme: "dark", packages: ["npm:fresh"] });
  });

  it("leaves the host settings.json alone when pi install fails", async () => {
    const volume = volumeBackend(installing(1));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: ["npm:old"] });

    expect(await run(["install", "npm:fresh"], harness.deps)).toBe(1);
    expect(await hostSettings(harness)).toEqual({ packages: ["npm:old"] });
  });

  it("refuses to write back a path that exists only inside the sandbox", async () => {
    const volume = volumeBackend(installing(0));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: [] });

    expect(await run(["install", "/tmp/inside"], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({ packages: [] });
    expect(harness.stderr()).toContain("pi-sandbox: /tmp/inside is a path inside the sandbox");
  });

  it("installs a package from the repository in the sandbox only", async () => {
    const volume = volumeBackend(installing(0));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });

    await mkdir(join(harness.repoRoot, "ext"), { recursive: true });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: [] });

    expect(await run(["install", "../ext"], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({ packages: [] });
    expect(harness.stderr()).toContain(
      "pi-sandbox: ../ext lies in the repository, which the sandbox can rewrite; installed in the sandbox only",
    );
  });

  it("refuses a package outside the repository that links back into it", async () => {
    const volume = volumeBackend(installing(0));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });
    const link = join(harness.deps.home, "tools", "ext");

    await mkdir(join(harness.repoRoot, "ext"), { recursive: true });

    await mkdir(join(harness.deps.home, "tools"), { recursive: true });

    await symlink(join(harness.repoRoot, "ext"), link);

    await harness.writeJson(harness.userConfigFile, { mounts: { extraReadOnly: ["~/tools"] } });

    harness.deps.env.HOME = harness.deps.home;

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: [] });

    expect(await run(["install", link], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({ packages: [] });
    expect(harness.stderr()).toContain("installed in the sandbox only");
  });

  it("writes back a package under an extra read-only mount as a path relative to the host agent dir", async () => {
    const volume = volumeBackend(installing(0));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });
    const ext = join(harness.deps.home, "tools", "ext");
    const file = join(harness.hostAgentDir, "settings.json");

    await mkdir(ext, { recursive: true });

    await harness.writeJson(harness.userConfigFile, { mounts: { extraReadOnly: ["~/tools"] } });

    harness.deps.env.HOME = harness.deps.home;

    await harness.writeJson(file, { packages: [] });

    expect(await run(["install", ext], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({ packages: ["../../tools/ext"] });
    expect(harness.stderr()).toContain(`pi-sandbox: added ../../tools/ext in ${file}`);
  });

  it("writes nothing and names both sources when the sandbox recorded a different entry for the package", async () => {
    const swapped = "npm:fresh@git+https://attacker.example/x.git";
    const volume = volumeBackend(recording((packages) => [...packages, swapped]));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });
    const file = join(harness.hostAgentDir, "settings.json");

    await harness.writeJson(file, { packages: ["npm:old"] });

    expect(await run(["install", "npm:fresh"], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({ packages: ["npm:old"] });
    expect(harness.stderr()).toContain(
      `pi-sandbox: the sandbox recorded ${swapped} instead of npm:fresh; ${file} was left as it is`,
    );
  });

  it("writes the typed source into a host object entry, keeps the host fields and copies nothing from the volume", async () => {
    const volume = volumeBackend(
      recording(() => [{ source: "npm:tool@2.0.0", extensions: ["planted.js"], skills: [] }]),
    );
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });
    const file = join(harness.hostAgentDir, "settings.json");

    await harness.writeJson(file, { packages: [{ source: "npm:tool@1.0.0", skills: ["review"] }] });

    expect(await run(["install", "npm:tool@2.0.0"], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({
      packages: [{ source: "npm:tool@2.0.0", skills: ["review"] }],
    });
    expect(harness.stderr()).toContain(`pi-sandbox: added npm:tool@2.0.0 in ${file}`);
  });

  it("leaves the host alone when an install drops an entry or a remove finds none", async () => {
    const volume = volumeBackend(recording(() => []));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: ["npm:old"] });

    expect(await run(["install", "npm:old"], harness.deps)).toBe(0);
    expect(await run(["remove", "npm:ghost"], harness.deps)).toBe(0);
    expect(await hostSettings(harness)).toEqual({ packages: ["npm:old"] });
    expect(harness.stderr()).not.toContain("removed");
  });

  it("passes a project install with -l straight through", async () => {
    const volume = volumeBackend(installing(0));
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: [] });

    expect(await run(["install", "npm:local", "-l"], harness.deps)).toBe(0);
    expect(volume.piRuns).toEqual([["install", "npm:local", "-l"]]);
    expect(await hostSettings(harness)).toEqual({ packages: [] });
  });
});

describe("pi mcp", () => {
  const noBackend = () => {
    throw new Error("the backend must not be used");
  };

  it("runs mcp add and remove with the host pi against the host agent dir", async () => {
    const harness = await harnessWith({ adapters: noBackend });

    expect(await run(["mcp", "add", "docs", "--url", "https://docs.example.test/mcp"], harness.deps)).toBe(0);

    const call = harness.calls.find((entry) => entry.interactive);

    expect(call?.file).toBe(process.execPath);
    expect(call?.args.slice(1)).toEqual(["mcp", "add", "docs", "--url", "https://docs.example.test/mcp"]);
    expect(call?.options).toEqual({ cwd: harness.cwd });
  });

  it("signs in on the host against a one-server helper dir with only the sanitised server", async () => {
    const harness = await harnessWith({ adapters: noBackend });

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
    const harness = await harnessWith({ adapters: noBackend });

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
    const harness = await harnessWith({ adapters: noBackend });

    await harness.writeJson(join(harness.repoRoot, ".pi", "mcp.json"), {
      mcpServers: { repo: { url: "https://repo.example.test/mcp" } },
    });

    expect(await run(["mcp", "login", "repo"], harness.deps)).toBe(1);
    expect(harness.questions).toEqual([
      expect.stringContaining("mcp repo is defined only in this repository"),
    ]);
    expect(harness.calls.some((entry) => entry.interactive)).toBe(false);

    const confirming = await harnessWith({ adapters: noBackend, confirm: true });

    await confirming.writeJson(join(confirming.repoRoot, ".pi", "mcp.json"), {
      mcpServers: { repo: { url: "https://repo.example.test/mcp" } },
    });

    expect(await run(["mcp", "login", "repo"], confirming.deps)).toBe(0);
    expect(confirming.calls.some((entry) => entry.interactive)).toBe(true);
  });
});

describe("pi update", () => {
  it("prints that pi follows the launcher for a bare pi update", async () => {
    const harness = await harnessWith({
      adapters: () => {
        throw new Error("the backend must not be used");
      },
    });

    expect(await run(["update"], harness.deps)).toBe(0);
    expect(harness.stdout()).toBe(
      "pi follows the launcher; update it with npm install -g pi-extensions-mz\n",
    );
  });

  it("runs pi update --extensions inside the sandbox", async () => {
    const volume = volumeBackend(() => 0);
    const harness = await harnessWith({ adapters: () => [volume.fake.backend] });

    expect(await run(["update", "--extensions"], harness.deps)).toBe(0);
    expect(volume.piRuns).toEqual([["update", "--extensions"]]);
  });
});
