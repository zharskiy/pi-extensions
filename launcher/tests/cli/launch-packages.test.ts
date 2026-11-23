import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecSpec } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { newLaunchId, registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex, stateLayout } from "../../shared/index.ts";
import { createFakeBackend, createHarness, isPiSession } from "./harness.ts";

const COMMIT_A = "a".repeat(40);

const COMMIT_B = "b".repeat(40);

const INSTALLING = "pi-sandbox: installing 1 extension in the shared pi folder; this can take a few minutes";

const DEFERRED =
  "pi-sandbox: sandbox packages follow the host: git packages refresh at the next launch (another session is running)";

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const removals = (execs: { spec: ExecSpec }[]) =>
  execs.filter((exec) => exec.spec.command[2]?.includes("rm -rf --") === true);

const isPiCommand = (spec: ExecSpec, word: string) =>
  spec.command[0] === "timeout" && spec.command.at(-1) === word;

const setup = async () => {
  const events: string[] = [];
  const installed = { now: false };
  const holder: { lock?: string; settings?: () => Promise<string | undefined> } = {};
  const fake = createFakeBackend({
    exec: async (spec, io) => {
      if (isPiSession(spec)) {
        events.push("pi");

        return 0;
      }

      if (isPiCommand(spec, "list")) {
        events.push("list");

        io.stdout.write(
          `User packages:\n  npm:tool\n${installed.now ? "    /pi/agent/npm/node_modules/tool\n" : ""}`,
        );

        return 0;
      }

      if (isPiCommand(spec, "--help")) {
        const locked = holder.lock !== undefined && (await exists(holder.lock));
        const synced = (await holder.settings?.())?.includes("npm:tool") === true;

        events.push(`install locked=${locked} synced=${synced}`);

        installed.now = true;

        return 0;
      }

      return undefined;
    },
  });
  const harness = await createHarness({ backend: () => fake.backend });

  holder.lock = stateLayout(harness.stateDir).agentLock;

  holder.settings = () => fake.guestFile("settings.json");

  await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: ["npm:tool"] });

  const launch = async () => {
    const before = harness.stderr().length;
    const code = await run([], harness.deps);

    return { code, stderr: harness.stderr().slice(before) };
  };

  return { fake, harness, events, installed, launch };
};

const hostGit = async (hostAgentDir: string, commit: string) => {
  const gitDir = join(hostAgentDir, "git", "github.com", "owner", "repo", ".git");

  await mkdir(join(gitDir, "refs", "heads"), { recursive: true });

  await mkdir(join(gitDir, "refs", "remotes", "origin"), { recursive: true });

  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");

  await writeFile(join(gitDir, "refs", "heads", "main"), `${commit}\n`);

  await writeFile(join(gitDir, "refs", "remotes", "origin", "main"), `${commit}\n`);
};

describe("installing the configured extensions before pi starts", () => {
  it("installs what is missing inside the agent lock, after the sync and before pi", async () => {
    const env = await setup();
    const first = await env.launch();

    expect(first.code).toBe(0);
    expect(env.events).toEqual(["list", "install locked=true synced=true", "list", "pi"]);
    expect(first.stderr).toContain(INSTALLING);

    const second = await env.launch();

    expect(env.events.slice(4)).toEqual(["list", "pi"]);
    expect(second.stderr).not.toContain("installing");
  });

  it("says which extension is still missing and starts pi anyway", async () => {
    const stuck = createFakeBackend({
      exec: (spec, io) => {
        if (isPiCommand(spec, "list")) {
          io.stdout.write("User packages:\n  npm:tool\n");
        }

        return isPiCommand(spec, "--help") || isPiCommand(spec, "list") ? 0 : undefined;
      },
    });
    const harness = await createHarness({ backend: () => stuck.backend });

    await harness.writeJson(join(harness.hostAgentDir, "settings.json"), { packages: ["npm:tool"] });

    expect(await run([], harness.deps)).toBe(0);
    expect(harness.stderr()).toContain(
      "pi-sandbox: warning: npm:tool could not be installed in the shared pi folder; pi tries again when it starts",
    );
    expect(stuck.execs.filter((exec) => isPiSession(exec.spec))).toHaveLength(1);
  });

  it("runs nothing when pi in the sandbox is offline", async () => {
    const env = await setup();

    await env.harness.writeJson(env.harness.userConfigFile, { env: { set: { PI_OFFLINE: "1" } } });

    expect((await env.launch()).code).toBe(0);
    expect(env.events).toEqual(["pi"]);

    await env.harness.writeJson(env.harness.userConfigFile, {});

    expect(await run(["--offline"], env.harness.deps)).toBe(0);
    expect(env.events).toEqual(["pi", "pi"]);
  });

  it("defers the git refresh while a launch of another project runs", async () => {
    const env = await setup();

    await hostGit(env.harness.hostAgentDir, COMMIT_A);

    await env.harness.writeJson(join(env.harness.hostAgentDir, "settings.json"), {
      packages: ["git:github.com/owner/repo"],
    });

    await env.launch();

    const removalsBefore = removals(env.fake.execs).length;

    await hostGit(env.harness.hostAgentDir, COMMIT_B);

    await registerLaunch(env.harness.stateDir, {
      launchId: newLaunchId(),
      ...(await processMark()),
      repoHash: sha256Hex(join(env.harness.repoRoot, "..", "other-project")),
      startedAt: 1,
    });

    const deferred = await env.launch();

    expect(deferred.stderr).toContain(DEFERRED);
    expect(removals(env.fake.execs)).toHaveLength(removalsBefore);
  });
});
