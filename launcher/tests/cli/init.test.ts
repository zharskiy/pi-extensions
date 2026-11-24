import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { VmDesired, VmInspect } from "../../backend/index.ts";
import { type CliDeps, runPinata } from "../../cli/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { exists } from "../support/temp-dir.ts";
import { createFakeBackend, createHarness, holdLaunch } from "./harness.ts";
import { fakeInput, fakeOutput, KEY, pause } from "./prompt/fake-tty.ts";
import { AUTOMATIC_SIZE } from "./setup-fixtures.ts";

const HINT =
  "  hint: pass --yes to keep the current settings and apply them; PINATA_ROOT names the folder that holds your projects\n";

const listed = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });

  return entries.map((entry) => join(entry.parentPath, entry.name)).sort();
};

interface SetupOptions {
  env?: Record<string, string>;
  inspect?: VmInspect;
  workspaceRoot?: false;
}

const initSetup = async (options: SetupOptions = {}) => {
  const applied: VmDesired[] = [];
  const fake = createFakeBackend({
    vm: {
      inspect: async () => options.inspect ?? { state: "absent" },
      apply: async (desired) => {
        applied.push(desired);

        return "created";
      },
    },
  });
  const harness = await createHarness({
    backend: () => fake.backend,
    env: options.env,
    workspaceRoot: options.workspaceRoot,
  });
  const sessions = join(harness.hostAgentDir, "sessions");
  const vmState = stateLayout(harness.stateDir).vm;

  return { ...harness, applied, sessions, vmState };
};

const withTty = (deps: CliDeps, extra: Partial<CliDeps> = {}) => {
  const input = fakeInput();
  const output = fakeOutput(100, 60);
  const ttyDeps: CliDeps = {
    ...deps,
    terminal: { ...deps.terminal, stdin: input, stderr: output },
    ...extra,
  };

  return { input, output, deps: ttyDeps };
};

const until = async (ready: () => boolean): Promise<void> => {
  if (ready()) {
    return;
  }

  await pause(5);
  return until(ready);
};

const PLAIN_QUESTION = /: $/;

const answered = (
  input: ReturnType<typeof fakeInput>,
  output: ReturnType<typeof fakeOutput>,
  ...lines: string[]
) =>
  lines.reduce(
    (chain, line) =>
      chain.then(async (shown) => {
        await until(
          () => output.text().length > shown && PLAIN_QUESTION.test(stripVTControlCharacters(output.text())),
        );

        const asked = output.text().length;

        input.write(`${line}\r`);

        return asked;
      }),
    Promise.resolve(0),
  );

describe("pinata init without a terminal", () => {
  it("refuses without a terminal, and with CI set even on one, and changes nothing", async () => {
    const harness = await initSetup();
    const before = await listed(harness.root);

    expect(await runPinata(["init"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe(`pinata: pinata init asks questions and needs a terminal\n${HINT}`);

    const ci = await initSetup({ env: { CI: "true" } });
    const tty = withTty(ci.deps, { openTty: () => fakeTtyStreams() });

    expect(await runPinata(["init"], tty.deps)).toBe(1);
    expect(ci.stderr()).toBe(`pinata: pinata init asks questions, and CI is set\n${HINT}`);
    expect(tty.output.text()).toBe("");
    expect(await listed(harness.root)).toEqual(before);
  });

  it("takes an unopenable /dev/tty as no terminal", async () => {
    const harness = await initSetup();
    const deps = {
      ...harness.deps,
      openTty: () => {
        throw Object.assign(new Error("ENXIO: no such device"), { code: "ENXIO" });
      },
    };

    expect(await runPinata(["init"], deps)).toBe(1);
    expect(harness.stderr()).toContain("pinata init asks questions and needs a terminal");
  });

  it("refuses other arguments and prints its usage", async () => {
    const harness = await initSetup();

    expect(await runPinata(["init", "extra"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe('pinata: unknown init option "extra"\n  hint: pinata init [--yes]\n');
    expect(await runPinata(["init", "--help"], harness.deps)).toBe(0);
    expect(await runPinata(["help"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("usage: pinata init [--yes]\n");
    expect(harness.stdout()).toContain(
      "set up or change the folder that holds your projects, VM size and settings write-back, then apply them to the sandbox VM; --yes asks nothing and applies the current settings",
    );
  });
});

const fakeTtyStreams = (closed: string[] = []) => ({
  input: fakeInput(),
  output: fakeOutput(100, 60),
  close: () => {
    closed.push("closed");
  },
});

describe("pinata init --yes", () => {
  it("plans the share of a bind source outside the roots, as a launch does", async () => {
    const harness = await initSetup();
    const work = join(harness.deps.home, "work");
    const reference = join(harness.deps.home, "reference");
    const config = {
      workspaceRoot: "~/work",
      mounts: { binds: [{ source: "~/reference", target: "/etc/reference" }] },
    };

    await mkdir(work, { recursive: true });

    await mkdir(reference, { recursive: true });

    await mkdir(dirname(harness.userConfigFile), { recursive: true });

    await writeFile(harness.userConfigFile, JSON.stringify(config));

    expect(await runPinata(["init", "--yes"], harness.deps)).toBe(0);
    expect(harness.applied.map((desired) => desired.shares)).toEqual([
      [
        { location: work, writable: true },
        { location: harness.sessions, writable: true },
        { location: harness.vmState, writable: false },
        { location: reference, writable: false },
      ],
    ]);
  });

  it("writes the root of PINATA_ROOT into a new config and creates the VM with it", async () => {
    const harness = await initSetup({ workspaceRoot: false });
    const work = join(harness.deps.home, "work");

    await mkdir(work, { recursive: true });

    const deps = { ...harness.deps, env: { ...harness.deps.env, PINATA_ROOT: "~/work/" } };

    expect(await runPinata(["init", "--yes"], deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({ workspaceRoot: "~/work" });
    expect((await stat(harness.userConfigFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(harness.userConfigFile))).mode & 0o777).toBe(0o700);
    expect(harness.applied).toEqual([
      {
        size: AUTOMATIC_SIZE,
        shares: [
          { location: work, writable: true },
          { location: harness.sessions, writable: true },
          { location: harness.vmState, writable: false },
        ],
      },
    ]);
    expect(harness.stdout()).toBe(
      [
        "  Project folder: ~/work (changed)",
        "  VM size: 8 CPUs, 10 GiB memory, 60 GiB disk (automatic)",
        "  Settings write-back: on (default)",
        "When you apply:",
        `  - create ${harness.userConfigFile}`,
        '      added workspaceRoot: "~/work"',
        "  - create the sandbox VM with this folder, pi's sessions folder and pinata's read-only state/vm folder; this takes a minute or two, longer the first time while colima downloads the VM's system image",
        `Saved ${harness.userConfigFile}`,
        "Created the VM in 0s: 8 CPUs, 10 GiB memory, 60 GiB disk",
        "Done. The sandbox is ready.",
        "Next: cd <a project in ~/work> && pi",
        "Change: pinata init",
        "Check: pinata doctor",
        `Settings: ${harness.userConfigFile}`,
        "",
      ].join("\n"),
    );
    expect(harness.stderr()).toBe("");
  });

  it("accepts a root that does not exist, saying it is not shared", async () => {
    const harness = await initSetup({ workspaceRoot: false });
    const gone = join(harness.deps.home, "gone");
    const deps = { ...harness.deps, env: { ...harness.deps.env, PINATA_ROOT: gone } };

    expect(await runPinata(["init", "--yes"], deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({ workspaceRoot: gone });
    expect(harness.stderr()).toBe(
      `pinata: workspaceRoot: ${gone} is missing, so it is not shared until it exists\n`,
    );
  });

  it("resolves a relative PINATA_ROOT against the current folder", async () => {
    const harness = await initSetup({ env: { PINATA_ROOT: ".." }, workspaceRoot: false });

    expect(await runPinata(["init", "--yes"], harness.deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoot: harness.repoRoot,
    });
  });

  it("keeps a config with the same root written another way, and says nothing changes", async () => {
    const harness = await initSetup();
    const text = JSON.stringify({
      workspaceRoot: `${harness.repoRoot}/`,
      env: { allow: ["FOO"] },
    });

    await harness.writeJson(harness.userConfigFile, JSON.parse(text));

    const before = await stat(harness.userConfigFile);
    const deps = { ...harness.deps, env: { ...harness.deps.env, PINATA_ROOT: harness.repoRoot } };
    const fake = createFakeBackend({
      vm: {
        inspect: async () => ({
          state: "running",
          size: AUTOMATIC_SIZE,
          shares: [
            { location: harness.repoRoot, writable: true },
            { location: harness.sessions, writable: true },
            { location: harness.vmState, writable: false },
          ],
        }),
      },
    });

    expect(await runPinata(["init", "--yes"], { ...deps, backend: () => fake.backend })).toBe(0);
    expect(harness.stdout()).toBe(
      "Everything is set up: the file and the sandbox VM already match these settings.\n",
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(text);
    expect((await stat(harness.userConfigFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses a config with another root than PINATA_ROOT and leaves it as it is", async () => {
    const harness = await initSetup();
    const text = JSON.stringify({ workspaceRoot: harness.repoRoot });

    await mkdir(join(harness.root, "other"));

    await harness.writeJson(harness.userConfigFile, JSON.parse(text));

    const deps = {
      ...harness.deps,
      env: { ...harness.deps.env, PINATA_ROOT: join(harness.root, "other") },
    };

    expect(await runPinata(["init", "--yes"], deps)).toBe(1);
    expect(harness.stderr()).toBe(
      `pinata: ${harness.userConfigFile} has another workspaceRoot than PINATA_ROOT\n  hint: edit workspaceRoot in ${harness.userConfigFile}, or unset PINATA_ROOT\n`,
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(text);
    expect(harness.applied).toEqual([]);
  });

  it("refuses without workspaceRoot and PINATA_ROOT, and writes nothing", async () => {
    const harness = await initSetup({ workspaceRoot: false });

    expect(await runPinata(["init", "--yes"], harness.deps)).toBe(1);
    expect(await exists(harness.userConfigFile)).toBe(false);
    expect(harness.applied).toEqual([]);
    expect(harness.stderr()).toBe(
      `pinata: ${harness.userConfigFile} has no workspaceRoot and PINATA_ROOT is not set, so there is no folder to share with the sandbox VM\n  hint: run pinata init in a terminal to choose the folder that holds your projects, or set PINATA_ROOT to it\n`,
    );
  });

  it("refuses a PINATA_ROOT that is the home or holds it, and writes nothing", async () => {
    const outcomes = await Promise.all(
      ["~", "~/..", "/"].map(async (root) => {
        const harness = await initSetup({ env: { PINATA_ROOT: root }, workspaceRoot: false });
        const code = await runPinata(["init", "--yes"], harness.deps);

        return {
          code,
          written: await exists(harness.userConfigFile),
          applied: harness.applied.length,
          hint: harness.stderr().split("\n")[1],
        };
      }),
    );

    expect(outcomes).toEqual(
      ["~", "~/..", "/"].map(() => ({
        code: 1,
        written: false,
        applied: 0,
        hint: "  hint: point PINATA_ROOT at the folder that holds your projects",
      })),
    );
  });

  it("keeps the running VM while pi sessions run", async () => {
    const harness = await initSetup({
      env: { PINATA_ROOT: "" },
      inspect: { state: "running", size: AUTOMATIC_SIZE, shares: [] },
    });

    await holdLaunch(harness);

    expect(await runPinata(["init", "--yes"], harness.deps)).toBe(0);
    expect(harness.stdout().split("\n").slice(0, 7)).toEqual([
      `  Project folder: ${harness.repoRoot} (current)`,
      "  VM size: 8 CPUs, 10 GiB memory, 60 GiB disk (automatic)",
      "  Settings write-back: on (default)",
      "When you apply:",
      "  - keep the sandbox VM as it is for now: 1 pi session is running. The first pi you start after it exits restarts it with the new folders",
      "! Kept as it is: 1 pi session is running. The first pi you start after it exits restarts it with the new folders.",
      "Done. Settings saved.",
    ]);
    expect(harness.applied).toEqual([]);
  });

  it("refuses a config that is not JSON or has a bad key, and leaves it untouched", async () => {
    const harness = await initSetup();

    await mkdir(dirname(harness.userConfigFile), { recursive: true });

    await writeFile(harness.userConfigFile, "{ nope");

    expect(await runPinata(["init", "--yes"], harness.deps)).toBe(1);
    expect(harness.stderr()).toMatch(
      new RegExp(
        `^pinata: ${harness.userConfigFile} is not valid JSON: .+\n  hint: fix the file, or move it away to start over, then run pinata init again\n$`,
      ),
    );

    await writeFile(harness.userConfigFile, JSON.stringify({ egress: { allow: 3 } }));

    expect(await runPinata(["init", "--yes"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pinata: ${harness.userConfigFile} has a problem this setup does not fix: config: egress.allow must be an array\n  hint: fix that key, then run pinata init again\n`,
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(JSON.stringify({ egress: { allow: 3 } }));
    expect(harness.applied).toEqual([]);
  });

  it("refuses a vm above what this Mac has before it writes or touches the VM", async () => {
    const harness = await initSetup({ env: { PINATA_ROOT: "" } });

    await harness.writeJson(harness.userConfigFile, { vm: { cpus: 12 } });

    const text = await readFile(harness.userConfigFile, "utf8");
    const deps = { ...harness.deps, env: { ...harness.deps.env, PINATA_ROOT: harness.repoRoot } };

    expect(await runPinata(["init", "--yes"], deps)).toBe(1);
    expect(harness.stderr()).toBe(
      `pinata: config: vm.cpus 12 is more than the 8 CPUs of this Mac\n  hint: lower it in ${harness.userConfigFile}, or run pinata init to choose a size\n`,
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(text);
    expect(harness.applied).toEqual([]);
  });

  it("refuses an invalid owned key as other commands do and rewrites nothing", async () => {
    const configs = [{ vm: { cpus: "4" } }, { writeBack: { enabled: "yes" } }];
    const outcomes = await Promise.all(
      configs.map(async (config) => {
        const harness = await initSetup();

        await harness.writeJson(harness.userConfigFile, config);

        const text = await readFile(harness.userConfigFile, "utf8");
        const code = await runPinata(["init", "--yes"], harness.deps);
        const kept = (await readFile(harness.userConfigFile, "utf8")) === text;

        return {
          code,
          kept,
          applied: harness.applied.length,
          stderr: harness.stderr(),
          hint: harness.userConfigFile,
        };
      }),
    );

    outcomes.forEach((outcome) => {
      expect(outcome).toMatchObject({ code: 1, kept: true, applied: 0 });
      expect(outcome.stderr).toMatch(new RegExp(`^pinata: config: \\S+ .+\n  hint: fix ${outcome.hint}\n$`));
    });
    expect(outcomes.map((outcome) => outcome.stderr.split("\n")[0])).toEqual([
      expect.stringContaining("config: vm.cpus "),
      expect.stringContaining("config: writeBack.enabled "),
    ]);
  });

  it("saves the config and exits 0 with one notice when the VM cannot be checked", async () => {
    const harness = await initSetup({ workspaceRoot: false });
    const fake = createFakeBackend({
      vm: {
        inspect: async () => {
          throw new LauncherError("colima did not answer within 3 seconds");
        },
      },
    });
    const deps = {
      ...harness.deps,
      env: { ...harness.deps.env, PINATA_ROOT: harness.repoRoot },
      backend: () => fake.backend,
    };

    expect(await runPinata(["init", "--yes"], deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoot: harness.repoRoot,
    });
    expect(harness.stderr()).toBe(
      "! The VM could not be checked (colima did not answer within 3 seconds). Run pinata doctor to see why.\n",
    );
    expect(harness.stdout()).toContain(
      "  - the sandbox VM could not be checked (colima did not answer within 3 seconds); run pinata doctor after applying\nSaved ",
    );
    expect(harness.stdout()).toMatch(/\nSaved .+\nDone\. Settings saved\.\n/);
  });

  it("fails with the VM's error after saving the config", async () => {
    const harness = await initSetup({ env: { PINATA_ROOT: "" }, workspaceRoot: false });
    const fake = createFakeBackend({
      vm: {
        apply: async () => {
          throw new LauncherError(
            "could not create the sandbox VM: colima start failed\nno space left",
            "see the colima log",
          );
        },
      },
    });
    const deps = {
      ...harness.deps,
      env: { ...harness.deps.env, PINATA_ROOT: harness.repoRoot },
      backend: () => fake.backend,
    };

    expect(await runPinata(["init", "--yes"], deps)).toBe(1);
    expect(await exists(harness.userConfigFile)).toBe(true);
    expect(harness.stderr()).toBe(
      [
        "x Could not create the VM after 0s.",
        "  no space left; see the colima log",
        "Your settings are saved, but the sandbox VM is not ready. Fix the problem above, then run pinata init again. pinata doctor checks everything.",
        "",
      ].join("\n"),
    );
    expect(harness.stdout()).toMatch(
      /^ {2}Project folder: [\s\S]*\nWhen you apply:\n[\s\S]*\nSaved [^\n]+\n$/,
    );
  });

  it("lets an unexpected error from the VM step reach the error handler after saving the config", async () => {
    const harness = await initSetup({ env: { PINATA_ROOT: "" }, workspaceRoot: false });
    const fake = createFakeBackend({
      vm: {
        apply: async () => {
          throw new Error("EACCES: permission denied, mkdir");
        },
      },
    });
    const deps = {
      ...harness.deps,
      env: { ...harness.deps.env, PINATA_ROOT: harness.repoRoot },
      backend: () => fake.backend,
    };

    expect(await runPinata(["init", "--yes"], deps)).toBe(70);
    expect(await exists(harness.userConfigFile)).toBe(true);
    expect(harness.stderr()).toBe("pinata: unexpected error: EACCES: permission denied, mkdir\n");
  });

  it("prints the review with the changed share before restarting a running VM", async () => {
    const harness = await initSetup();
    const old = join(harness.root, "old");

    await mkdir(old);

    const fake = createFakeBackend({
      vm: {
        inspect: async () => ({
          state: "running",
          size: AUTOMATIC_SIZE,
          shares: [
            { location: old, writable: true },
            { location: harness.sessions, writable: true },
            { location: harness.vmState, writable: false },
          ],
        }),
        apply: async () => "restarted",
      },
    });
    const deps = { ...harness.deps, backend: () => fake.backend };

    expect(await runPinata(["init", "--yes"], deps)).toBe(0);
    expect(harness.stdout().split("\n").slice(0, 7)).toEqual([
      `  Project folder: ${harness.repoRoot} (current)`,
      "  VM size: 8 CPUs, 10 GiB memory, 60 GiB disk (automatic)",
      "  Settings write-back: on (default)",
      "When you apply:",
      "  - restart the sandbox VM with the new folders; no pi session is running, and this usually takes under a minute",
      "Restarted the VM in 0s with the new folders",
      "Done. The sandbox is ready.",
    ]);
    expect(harness.stderr()).toBe("");
  });
});

const gitRepo = async (dir: string) => {
  await mkdir(join(dir, ".git"), { recursive: true });
};

describe("pinata init at a terminal", () => {
  it("runs the plain setup, saves the chosen folder and creates the VM", async () => {
    const harness = await initSetup({ env: { PINATA_PLAIN: "1" }, workspaceRoot: false });
    const projects = join(harness.deps.home, "Projects");

    await gitRepo(join(projects, "app"));

    const tty = withTty(harness.deps);
    const exit = runPinata(["init"], tty.deps);

    await answered(tty.input, tty.output, "", "", "", "");

    expect(await exit).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoot: "~/Projects",
    });
    expect(harness.applied).toEqual([
      {
        size: AUTOMATIC_SIZE,
        shares: [
          { location: projects, writable: true },
          { location: harness.sessions, writable: true },
          { location: harness.vmState, writable: false },
        ],
      },
    ]);
    expect(tty.output.screen.lines()).toContain("Done. The sandbox is ready.");
    expect(harness.stdout()).toBe("");
    expect(tty.input.rawCalls.at(-1) ?? false).toBe(false);
  });

  it("uses /dev/tty when stdin is piped, and closes it after a cancel that leaves nothing behind", async () => {
    const harness = await initSetup({ workspaceRoot: false });
    const closed: string[] = [];
    const streams = fakeTtyStreams(closed);
    const piped = new PassThrough();
    const deps = {
      ...harness.deps,
      terminal: { ...harness.deps.terminal, stdin: piped },
      openTty: () => streams,
    };
    const before = await listed(harness.root);
    const exit = runPinata(["init"], deps);

    await until(() => streams.input.isRaw && streams.output.text().includes("step 1 of 3"));

    streams.input.write(KEY.ctrlC);

    expect(await exit).toBe(130);
    expect(streams.output.text()).toContain("Cancelled. Nothing was changed.");
    expect(closed).toEqual(["closed"]);
    expect(streams.input.isRaw).toBe(false);
    expect(await listed(harness.root)).toEqual(before);
  });

  it("restores the terminal and exits 143 on SIGTERM and 129 on SIGHUP", async () => {
    const harness = await initSetup();
    const exits = await Promise.all(
      (["SIGTERM", "SIGHUP"] as const).map(async (signal) => {
        const signals = new EventEmitter();
        const tty = withTty(harness.deps, { signals });
        const exit = runPinata(["init"], tty.deps);

        await until(() => signals.listenerCount(signal) > 0);

        signals.emit(signal);

        const code = await exit;

        return { code, raw: tty.input.isRaw, listeners: signals.listenerCount(signal) };
      }),
    );

    expect(exits).toEqual([
      { code: 143, raw: false, listeners: 0 },
      { code: 129, raw: false, listeners: 0 },
    ]);
  });

  it("shows an invalid config and exits 1 without touching it", async () => {
    const harness = await initSetup({ env: { PINATA_PLAIN: "1" } });

    await mkdir(dirname(harness.userConfigFile), { recursive: true });

    await writeFile(harness.userConfigFile, "[]");

    const tty = withTty(harness.deps);

    expect(await runPinata(["init"], tty.deps)).toBe(1);
    expect(tty.output.text()).toContain("is not valid JSON:");
    expect(await readFile(harness.userConfigFile, "utf8")).toBe("[]");
  });
});
