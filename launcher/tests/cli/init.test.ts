import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { VmDesired, VmInspect } from "../../backend/index.ts";
import { type CliDeps, run } from "../../cli/index.ts";
import { LauncherError, stateLayout } from "../../shared/index.ts";
import { createFakeBackend, createHarness, holdLaunch } from "./harness.ts";
import { fakeInput, fakeOutput, KEY, pause } from "./prompt/fake-tty.ts";

const HINT =
  "  hint: pass --yes to keep the current settings and apply them; PI_SANDBOX_ROOTS names project folders\n";

const AUTOMATIC = { cpus: 8, memoryGiB: 10, diskGiB: 60 };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const listed = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });

  return entries.map((entry) => join(entry.parentPath, entry.name)).sort();
};

interface SetupOptions {
  env?: Record<string, string>;
  inspect?: VmInspect;
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
  const harness = await createHarness({ backend: () => fake.backend, env: options.env });
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

describe("pi sandbox init without a terminal", () => {
  it("refuses without a terminal, and with CI set even on one, and changes nothing", async () => {
    const harness = await initSetup();
    const before = await listed(harness.root);

    expect(await run(["sandbox", "init"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe(`pi-sandbox: pi sandbox init asks questions and needs a terminal\n${HINT}`);

    const ci = await initSetup({ env: { CI: "true" } });
    const tty = withTty(ci.deps, { openTty: () => fakeTtyStreams() });

    expect(await run(["sandbox", "init"], tty.deps)).toBe(1);
    expect(ci.stderr()).toBe(`pi-sandbox: pi sandbox init asks questions, and CI is set\n${HINT}`);
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

    expect(await run(["sandbox", "init"], deps)).toBe(1);
    expect(harness.stderr()).toContain("pi sandbox init asks questions and needs a terminal");
  });

  it("refuses other arguments and prints its usage", async () => {
    const harness = await initSetup();

    expect(await run(["sandbox", "init", "extra"], harness.deps)).toBe(1);
    expect(harness.stderr()).toBe(
      'pi-sandbox: unknown init option "extra"\n  hint: pi sandbox init [--yes]\n',
    );
    expect(await run(["sandbox", "init", "--help"], harness.deps)).toBe(0);
    expect(await run(["sandbox", "help"], harness.deps)).toBe(0);
    expect(harness.stdout()).toContain("usage: pi sandbox init [--yes]\n");
    expect(harness.stdout()).toContain(
      "set up or change the project folders, VM size and settings write-back, then apply them to the sandbox VM; --yes asks nothing and applies the current settings",
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

describe("pi sandbox init --yes", () => {
  it("writes the roots of PI_SANDBOX_ROOTS into a new config and creates the VM with them", async () => {
    const harness = await initSetup();
    const work = join(harness.deps.home, "work");

    await mkdir(work, { recursive: true });

    const deps = {
      ...harness.deps,
      env: { ...harness.deps.env, PI_SANDBOX_ROOTS: `~/work:${harness.repoRoot}/` },
    };

    expect(await run(["sandbox", "init", "--yes"], deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoots: { roots: ["~/work", harness.repoRoot] },
    });
    expect((await stat(harness.userConfigFile)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(harness.userConfigFile))).mode & 0o777).toBe(0o700);
    expect(harness.applied).toEqual([
      {
        size: AUTOMATIC,
        shares: [
          { location: work, writable: true },
          { location: harness.repoRoot, writable: true },
          { location: harness.sessions, writable: true },
          { location: harness.vmState, writable: false },
        ],
        exactShares: true,
      },
    ]);
    expect(harness.stdout()).toBe(
      [
        `Saved ${harness.userConfigFile}`,
        "Created the VM in 0s: 8 CPUs, 10 GiB memory, 60 GiB disk",
        "Done. The sandbox is ready.",
        "Next: cd <a project in ~/work> && pi",
        "Change: pi sandbox init",
        "Check: pi sandbox doctor",
        `Settings: ${harness.userConfigFile}`,
        "",
      ].join("\n"),
    );
    expect(harness.stderr()).toBe("");
  });

  it("resolves a relative PI_SANDBOX_ROOTS entry against the current folder", async () => {
    const harness = await initSetup({ env: { PI_SANDBOX_ROOTS: ".." } });

    expect(await run(["sandbox", "init", "--yes"], harness.deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoots: { roots: [harness.repoRoot] },
    });
  });

  it("keeps a config with the same roots written another way, and says nothing changes", async () => {
    const harness = await initSetup();
    const text = JSON.stringify({
      workspaceRoots: { roots: [`${harness.repoRoot}/`] },
      env: { allow: ["FOO"] },
    });

    await harness.writeJson(harness.userConfigFile, JSON.parse(text));

    const before = await stat(harness.userConfigFile);
    const deps = { ...harness.deps, env: { ...harness.deps.env, PI_SANDBOX_ROOTS: harness.repoRoot } };
    const fake = createFakeBackend({
      vm: {
        inspect: async () => ({
          state: "running",
          size: AUTOMATIC,
          shares: [
            { location: harness.repoRoot, writable: true },
            { location: harness.sessions, writable: true },
            { location: harness.vmState, writable: false },
          ],
        }),
      },
    });

    expect(await run(["sandbox", "init", "--yes"], { ...deps, backend: () => fake.backend })).toBe(0);
    expect(harness.stdout()).toBe(
      "Everything is set up: the file and the sandbox VM already match these settings.\n",
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(text);
    expect((await stat(harness.userConfigFile)).mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses a config with other roots than PI_SANDBOX_ROOTS and leaves it as it is", async () => {
    const harness = await initSetup();
    const text = JSON.stringify({ workspaceRoots: { roots: [harness.repoRoot] } });

    await mkdir(join(harness.root, "other"));

    await harness.writeJson(harness.userConfigFile, JSON.parse(text));

    const deps = {
      ...harness.deps,
      env: { ...harness.deps.env, PI_SANDBOX_ROOTS: join(harness.root, "other") },
    };

    expect(await run(["sandbox", "init", "--yes"], deps)).toBe(1);
    expect(harness.stderr()).toBe(
      `pi-sandbox: ${harness.userConfigFile} has other workspaceRoots than PI_SANDBOX_ROOTS\n  hint: edit workspaceRoots in ${harness.userConfigFile}, or unset PI_SANDBOX_ROOTS\n`,
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(text);
    expect(harness.applied).toEqual([]);
  });

  it("shares the home without roots, writes nothing and says how to choose folders", async () => {
    const harness = await initSetup();

    expect(await run(["sandbox", "init", "--yes"], harness.deps)).toBe(0);
    expect(await exists(harness.userConfigFile)).toBe(false);
    expect(harness.applied).toEqual([
      { size: AUTOMATIC, shares: [{ location: harness.deps.home, writable: true }], exactShares: true },
    ]);
    expect(harness.stderr()).toBe(
      "pi-sandbox: no workspaceRoots, so the sandbox VM shares your whole home; run pi sandbox init in a terminal to choose project folders\n",
    );
    expect(harness.stdout()).toContain(
      "Created the VM in 0s: 8 CPUs, 10 GiB memory, 60 GiB disk\nDone. The sandbox is ready.\nNext: cd <a project> && pi\n",
    );
  });

  it("keeps the running VM while pi sessions run", async () => {
    const harness = await initSetup({
      env: { PI_SANDBOX_ROOTS: "" },
      inspect: { state: "running", size: AUTOMATIC, shares: [] },
    });

    await harness.writeJson(harness.userConfigFile, { workspaceRoots: { roots: [harness.repoRoot] } });

    await holdLaunch(harness);

    expect(await run(["sandbox", "init", "--yes"], harness.deps)).toBe(0);
    expect(harness.stdout().split("\n").slice(0, 2)).toEqual([
      "! Kept as it is: 1 pi session is running. The first pi you start after it exits restarts it with the new folders.",
      "Done. Settings saved.",
    ]);
    expect(harness.applied).toEqual([]);
  });

  it("refuses a config that is not JSON or has a bad key, and leaves it untouched", async () => {
    const harness = await initSetup();

    await mkdir(dirname(harness.userConfigFile), { recursive: true });

    await writeFile(harness.userConfigFile, "{ nope");

    expect(await run(["sandbox", "init", "--yes"], harness.deps)).toBe(1);
    expect(harness.stderr()).toMatch(
      new RegExp(
        `^pi-sandbox: ${harness.userConfigFile} is not valid JSON: .+\n  hint: fix the file, or move it away to start over, then run pi sandbox init again\n$`,
      ),
    );

    await writeFile(harness.userConfigFile, JSON.stringify({ egress: { allow: 3 } }));

    expect(await run(["sandbox", "init", "--yes"], harness.deps)).toBe(1);
    expect(harness.stderr()).toContain(
      `pi-sandbox: ${harness.userConfigFile} has a problem this setup does not fix: config: egress.allow must be an array\n  hint: fix that key, then run pi sandbox init again\n`,
    );
    expect(await readFile(harness.userConfigFile, "utf8")).toBe(JSON.stringify({ egress: { allow: 3 } }));
    expect(harness.applied).toEqual([]);
  });

  it("refuses a vm above what this Mac has before it writes or touches the VM", async () => {
    const harness = await initSetup({ env: { PI_SANDBOX_ROOTS: "" } });

    await harness.writeJson(harness.userConfigFile, { vm: { cpus: 12 } });

    const text = await readFile(harness.userConfigFile, "utf8");
    const deps = { ...harness.deps, env: { ...harness.deps.env, PI_SANDBOX_ROOTS: harness.repoRoot } };

    expect(await run(["sandbox", "init", "--yes"], deps)).toBe(1);
    expect(harness.stderr()).toBe(
      `pi-sandbox: config: vm.cpus 12 is more than the 8 CPUs of this Mac\n  hint: lower it in ${harness.userConfigFile}, or run pi sandbox init to choose a size\n`,
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
        const code = await run(["sandbox", "init", "--yes"], harness.deps);
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
      expect(outcome.stderr).toMatch(
        new RegExp(`^pi-sandbox: config: \\S+ .+\n  hint: fix ${outcome.hint}\n$`),
      );
    });
    expect(outcomes.map((outcome) => outcome.stderr.split("\n")[0])).toEqual([
      expect.stringContaining("config: vm.cpus "),
      expect.stringContaining("config: writeBack.enabled "),
    ]);
  });

  it("saves the config and exits 0 with one notice when the VM cannot be checked", async () => {
    const harness = await initSetup();
    const fake = createFakeBackend({
      vm: {
        inspect: async () => {
          throw new LauncherError("colima did not answer within 3 seconds");
        },
      },
    });
    const deps = {
      ...harness.deps,
      env: { ...harness.deps.env, PI_SANDBOX_ROOTS: harness.repoRoot },
      backend: () => fake.backend,
    };

    expect(await run(["sandbox", "init", "--yes"], deps)).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoots: { roots: [harness.repoRoot] },
    });
    expect(harness.stderr()).toBe(
      "! The VM could not be checked (colima did not answer within 3 seconds). Run pi sandbox doctor to see why.\n",
    );
    expect(harness.stdout()).toMatch(/^Saved .+\nDone\. The sandbox is ready\.\n/);
  });

  it("fails with the VM's error after saving the config", async () => {
    const harness = await initSetup({ env: { PI_SANDBOX_ROOTS: "" } });
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
      env: { ...harness.deps.env, PI_SANDBOX_ROOTS: harness.repoRoot },
      backend: () => fake.backend,
    };

    expect(await run(["sandbox", "init", "--yes"], deps)).toBe(1);
    expect(await exists(harness.userConfigFile)).toBe(true);
    expect(harness.stderr()).toBe(
      [
        "x Could not create the VM after 0s.",
        "  no space left; see the colima log",
        "Your settings are saved, but the sandbox VM is not ready. Fix the problem above, then run pi sandbox init again. pi sandbox doctor checks everything.",
        "",
      ].join("\n"),
    );
    expect(harness.stdout()).toBe(`Saved ${harness.userConfigFile}\n`);
  });
});

const gitRepo = async (dir: string) => {
  await mkdir(join(dir, ".git"), { recursive: true });
};

describe("pi sandbox init at a terminal", () => {
  it("runs the plain setup, saves the chosen folder and creates the VM", async () => {
    const harness = await initSetup({ env: { PI_SANDBOX_PLAIN: "1" } });
    const projects = join(harness.deps.home, "Projects");

    await gitRepo(join(projects, "app"));

    const tty = withTty(harness.deps);
    const exit = run(["sandbox", "init"], tty.deps);

    await answered(tty.input, tty.output, "", "", "", "");

    expect(await exit).toBe(0);
    expect(JSON.parse(await readFile(harness.userConfigFile, "utf8"))).toEqual({
      workspaceRoots: { roots: ["~/Projects"] },
    });
    expect(harness.applied).toEqual([
      {
        size: AUTOMATIC,
        shares: [
          { location: projects, writable: true },
          { location: harness.sessions, writable: true },
          { location: harness.vmState, writable: false },
        ],
        exactShares: true,
      },
    ]);
    expect(tty.output.screen.lines()).toContain("Done. The sandbox is ready.");
    expect(harness.stdout()).toBe("");
    expect(tty.input.rawCalls.at(-1) ?? false).toBe(false);
  });

  it("uses /dev/tty when stdin is piped, and closes it after a cancel that leaves nothing behind", async () => {
    const harness = await initSetup();
    const closed: string[] = [];
    const streams = fakeTtyStreams(closed);
    const piped = new PassThrough();
    const deps = {
      ...harness.deps,
      terminal: { ...harness.deps.terminal, stdin: piped },
      openTty: () => streams,
    };
    const before = await listed(harness.root);
    const exit = run(["sandbox", "init"], deps);

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
        const exit = run(["sandbox", "init"], tty.deps);

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
    const harness = await initSetup({ env: { PI_SANDBOX_PLAIN: "1" } });

    await mkdir(dirname(harness.userConfigFile), { recursive: true });

    await writeFile(harness.userConfigFile, "[]");

    const tty = withTty(harness.deps);

    expect(await run(["sandbox", "init"], tty.deps)).toBe(1);
    expect(tty.output.text()).toContain("is not valid JSON:");
    expect(await readFile(harness.userConfigFile, "utf8")).toBe("[]");
  });
});
