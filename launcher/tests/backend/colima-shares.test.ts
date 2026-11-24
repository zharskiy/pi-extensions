import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vmSharesOf } from "../../backend/colima/colima-yaml.ts";
import { createColimaVm } from "../../backend/colima/vm.ts";
import { type Backend, LABELS, type Vm } from "../../backend/index.ts";
import { shareDrift } from "../../backend/vm-decision.ts";
import { run, runPinata } from "../../cli/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex } from "../../shared/index.ts";
import {
  createHarness,
  doctorCheck,
  writeColimaMounts,
  writeLimaMounts,
  type YamlMount,
} from "../cli/harness.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { argvOf, type FakeCall } from "../support/fake-runner.ts";

const PROFILE = { status: async () => ({ socket: "/fake/docker.sock", profile: "pi-sandbox" }) };

interface ColimaAnswers {
  start?: { code: number; stderr: string };
  keepLima?: boolean;
  missing?: boolean;
  vm?: { up: boolean };
}

const mountsOf = (args: string[]): YamlMount[] =>
  args.flatMap((arg, index) => {
    if (args[index - 1] !== "--mount") {
      return [];
    }

    return arg.endsWith(":w") ? [{ location: arg.slice(0, -2), writable: true }] : [{ location: arg }];
  });

const answerColima = async (home: string, answers: ColimaAnswers, call: FakeCall) => {
  if (call.args[0] === "status" && answers.vm !== undefined) {
    return { code: answers.vm.up ? 0 : 1 };
  }

  if (call.args[0] === "start" && answers.vm !== undefined) {
    answers.vm.up = true;
  }

  if (call.args[0] === "start" && answers.start !== undefined) {
    return answers.start;
  }

  if (call.args[0] === "start" && answers.keepLima !== true) {
    await writeLimaMounts(home, mountsOf(call.args));
  }

  return {};
};

const colima = (home: string, answers: ColimaAnswers) => (call: FakeCall) =>
  call.file === "colima" && answers.missing !== true ? answerColima(home, answers, call) : undefined;

interface Setup {
  lima?: (paths: Paths) => YamlMount[];
  answers?: ColimaAnswers;
  backend?: Partial<Backend>;
  vm?: Partial<Vm>;
  config?: unknown;
  workspaceRoot?: false;
}

interface Paths {
  root: string;
  home: string;
  repoRoot: string;
  stateDir: string;
}

const homeAndState = ({ home, stateDir }: Paths): YamlMount[] => [
  { location: home, writable: true },
  { location: stateDir },
];

const launchWith = async (setup: Setup = {}) => {
  const fake = createFakeBackend();
  const answers = setup.answers ?? {};
  const holder: { home: string; stateDir: string } = { home: "", stateDir: "" };
  const pauses: number[] = [];
  const harness = await createHarness({
    backend: () => {
      const backend = { ...fake.backend, ...PROFILE, ...setup.backend };
      const vm = createColimaVm({
        home: holder.home,
        stateDir: holder.stateDir,
        runner: harness.deps.runner,
        detect: () => backend.detect(),
        pause: async (ms) => {
          pauses.push(ms);
        },
      });

      return { ...backend, vm: { ...vm, ...setup.vm } };
    },
    respond: (call) => colima(holder.home, answers)(call),
    workspaceRoot: setup.workspaceRoot,
  });
  const paths = {
    root: harness.root,
    home: harness.deps.home,
    repoRoot: harness.repoRoot,
    stateDir: harness.stateDir,
  };

  holder.home = paths.home;

  holder.stateDir = paths.stateDir;

  await writeLimaMounts(paths.home, (setup.lima ?? homeAndState)(paths));

  await writeColimaMounts(paths.home, (setup.lima ?? homeAndState)(paths));

  if (setup.config !== undefined) {
    await harness.writeJson(harness.userConfigFile, setup.config);
  }

  return {
    harness,
    fake,
    paths,
    pauses,
    colimaCalls: () =>
      harness.calls
        .filter((call) => call.file === "colima" && call.args[0] !== "ssh")
        .map((call) => argvOf(call).join(" ")),
  };
};

const limaYaml = (home: string) => join(home, ".colima", "_lima", "colima-pi-sandbox", "lima.yaml");

const run0 = async (context: Awaited<ReturnType<typeof launchWith>>) => run([], context.harness.deps);

const restart = (mounts: string) => [
  "colima stop --profile pi-sandbox",
  `colima start --profile pi-sandbox --activate=false ${mounts}`,
];

describe("vmSharesOf", () => {
  const home = "/Users/dev";

  it("expands a quoted ~, drops a trailing slash and reads writable as false unless it is true", () => {
    const text = [
      "vmType: vz",
      "mounts:",
      '- location: "~"',
      "  writable: true",
      "- location: /Volumes/Data/",
      "  mountPoint: null",
      "ssh:",
      "  localPort: 0",
    ].join("\n");

    expect(vmSharesOf(text, home)).toEqual([
      { location: "/Users/dev", writable: true },
      { location: "/Volumes/Data", writable: false },
    ]);
  });

  it("reads the mounts colima 0.10.3 writes for the plan, in the ~/ form with trailing slashes, as no drift", () => {
    const text = [
      "mounts:",
      "    - location: /Volumes/Projects/",
      "      writable: true",
      "    - location: ~/.pi/agent/sessions/",
      "      writable: true",
      "    - location: ~/.pi/agent/pi-sandbox/state/vm/",
      "      writable: false",
    ].join("\n");
    const plan = [
      { location: "/Volumes/Projects", writable: true },
      { location: "/Users/dev/.pi/agent/sessions", writable: true },
      { location: "/Users/dev/.pi/agent/pi-sandbox/state/vm", writable: false },
    ];
    const shares = vmSharesOf(text, home) ?? [];

    expect(shares).toEqual(plan);
    expect(shareDrift(shares, plan)).toEqual({ extra: [], lacking: [] });
  });

  it("keeps a mountPoint that differs from the location, so the share counts as drift", () => {
    const text = [
      "mounts:",
      "- location: /Volumes/Data",
      "  writable: true",
      "  mountPoint: /mnt/data",
      "- location: /opt/x/",
      "  mountPoint: /opt/x",
    ].join("\n");
    const shares = vmSharesOf(text, home) ?? [];

    expect(shares).toEqual([
      { location: "/Volumes/Data", writable: true, mountPoint: "/mnt/data" },
      { location: "/opt/x", writable: false },
    ]);
    expect(shareDrift(shares, [{ location: "/Volumes/Data", writable: true }]).lacking).toHaveLength(1);
  });

  it("reads an empty list as no share, and a missing key or a flow-style list as unknown", () => {
    expect(vmSharesOf("cpu: 2\nmounts: []\n", home)).toEqual([]);
    expect(vmSharesOf("cpu: 2\n", home)).toBeUndefined();
    expect(vmSharesOf("mounts: [{location: /Volumes/X, writable: true}]\n", home)).toBeUndefined();
  });

  it("drops an inline comment from an unquoted value", () => {
    expect(
      vmSharesOf("mounts:\n- location: /opt/x # shared by hand\n  writable: true # yes\n", home),
    ).toEqual([{ location: "/opt/x", writable: true }]);
  });

  it("reads a quoted value with a comment, every YAML true, a comment after the key and CRLF lines", () => {
    const text = [
      "mounts: # shared by hand",
      '  - location: "/Volumes/My Disk" # mine',
      "    writable: True",
      "  - location: /opt/y",
      "    writable: yes",
      "  - location: /opt/z",
      "    writable: false",
    ].join("\r\n");

    expect(vmSharesOf(text, home)).toEqual([
      { location: "/Volumes/My Disk", writable: true },
      { location: "/opt/y", writable: true },
      { location: "/opt/z", writable: false },
    ]);
  });

  it("unescapes a doubled single quote and a backslash-escaped quote or backslash", () => {
    const text = [
      "mounts:",
      "  - location: '/Volumes/Bob''s Disk' # his",
      "    writable: true",
      '  - location: "/opt/say \\"hi\\"\\\\x"',
      "    writable: false",
    ].join("\n");

    expect(vmSharesOf(text, home)).toEqual([
      { location: "/Volumes/Bob's Disk", writable: true },
      { location: '/opt/say "hi"\\x', writable: false },
    ]);
  });

  it("reads a null list as no share and an entry it cannot parse as unknown", () => {
    expect(vmSharesOf("mounts: null\n", home)).toEqual([]);
    expect(
      vmSharesOf(`mounts:\n  - location: ${home}\n  - {location: /opt/x, writable: true}\n`, home),
    ).toBeUndefined();
  });
});

const rootsShares = ({ home, stateDir, repoRoot }: Paths): YamlMount[] => [
  { location: repoRoot, writable: true },
  { location: join(home, ".pi", "agent", "sessions"), writable: true },
  { location: join(stateDir, "vm") },
];

const rootsMounts = ({ home, stateDir, repoRoot }: Paths) =>
  `--mount ${repoRoot}:w --mount ${join(home, ".pi", "agent", "sessions")}:w --mount ${join(stateDir, "vm")}`;

const rootsLocations = ({ home, stateDir, repoRoot }: Paths) =>
  [repoRoot, join(home, ".pi", "agent", "sessions"), join(stateDir, "vm")].join(", ");

const dropsHomeAndState = ({ home, stateDir }: Paths) => ` (drops ${home}, ${stateDir})`;

const holdOtherLaunch = async (stateDir: string) => {
  await registerLaunch(stateDir, {
    launchId: "00000000000000dd",
    ...(await processMark()),
    repoHash: sha256Hex("/elsewhere"),
    startedAt: 1,
  });
};

describe("the launch shares the workspace root with the VM", () => {
  it("launches without asking colima when the VM shares exactly the planned set", async () => {
    const context = await launchWith({ lima: rootsShares });

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual([]);
    expect(context.harness.stderr()).not.toContain("sandbox VM");
    expect(context.fake.created).toHaveLength(1);
  });

  it("restarts a VM that still shares the home with exactly the planned set and prints one notice", async () => {
    const context = await launchWith();

    expect(await run0(context)).toBe(0);
    expect(context.harness.stderr()).toContain(
      `pinata: restarting the sandbox VM to change its shares to ${rootsLocations(context.paths)}${dropsHomeAndState(context.paths)}\n`,
    );
    expect(context.colimaCalls()).toEqual(restart(rootsMounts(context.paths)));
    expect(context.fake.created).toHaveLength(1);
  });

  it("upgrades a read-only root share when the root must be writable", async () => {
    const context = await launchWith({
      lima: (paths) => [{ location: paths.repoRoot }, ...rootsShares(paths).slice(1)],
    });

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(restart(rootsMounts(context.paths)));
  });

  it("takes an empty mountPoint, or one at the share's own path, as a plain mount", async () => {
    const context = await launchWith({
      lima: (paths) => {
        const [root, sessions, vm] = rootsShares(paths);

        return [{ ...root, mountPoint: '""' }, sessions, { ...vm, mountPoint: vm.location }];
      },
    });

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual([]);
  });

  it("replaces a share mounted at another path in the VM with the planned set", async () => {
    const context = await launchWith({
      lima: (paths) => {
        const [root, ...rest] = rootsShares(paths);

        return [{ ...root, mountPoint: "/mnt/work" }, ...rest];
      },
    });

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(restart(rootsMounts(context.paths)));
  });

  it("names the colima error when the start fails", async () => {
    const context = await launchWith({
      answers: { start: { code: 1, stderr: 'starting\nlevel=fatal msg="disk busy"\n' } },
    });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        `pinata: could not restart the sandbox VM: colima start failed: level=fatal msg="disk busy"`,
        `  hint: run colima start --profile pi-sandbox --activate=false ${rootsMounts(context.paths)} and see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log`,
      ].join("\n"),
    );
  });

  it("refuses when colima started without the share", async () => {
    const context = await launchWith({ answers: { keepLima: true } });
    const { repoRoot } = context.paths;

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pinata: colima did not share ${repoRoot} with the sandbox VM\n`,
    );
    expect(context.fake.containers.size).toBe(0);
  });

  it("names the missing colima", async () => {
    const context = await launchWith({ answers: { missing: true } });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "pinata: could not restart the sandbox VM: colima: command not found\n",
    );
  });

  it("asks the engine again for a few seconds, then says the VM did not come back", async () => {
    const detections = { count: 0 };
    const context = await launchWith({
      backend: {
        detect: async () => {
          detections.count += 1;

          return detections.count === 1
            ? { available: true }
            : { available: false, reason: "socket missing" };
        },
      },
    });

    expect(await run0(context)).toBe(1);
    expect(detections.count).toBeGreaterThanOrEqual(6);
    expect(context.pauses).toEqual([0, 500, 1000, 1500, 2000]);
    expect(context.harness.stderr()).toContain(
      "pinata: the sandbox VM did not come back after restarting it: socket missing\n",
    );
  });
});

describe("the coverage of the VM shares", () => {
  it("lists the shares and the paths they miss", async () => {
    const context = await launchWith();
    const { home, stateDir, repoRoot } = context.paths;
    const needs = [
      { path: repoRoot, writable: true },
      { path: stateDir, writable: false },
    ];

    expect(await context.harness.deps.backend().vm.coverage(needs)).toEqual({
      shares: [
        { location: home, writable: true },
        { location: stateDir, writable: false },
      ],
      missing: [repoRoot],
    });
  });

  it("lets pinata doctor name a path the VM lacks without sharing it or restarting the VM", async () => {
    const context = await launchWith();

    await runPinata(["doctor", "--verbose"], context.harness.deps);

    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({
      status: "warn",
      detail: `the sandbox VM does not share ${context.paths.repoRoot}`,
      hint: "run pi once here while no other pi session runs, which shares it and restarts the VM, then pinata doctor again",
    });
    expect(context.colimaCalls().filter((call) => /^colima (start|stop|restart)/.test(call))).toEqual([]);
  });

  it("lets pinata doctor say the VM shares every path it needs", async () => {
    const context = await launchWith({ lima: rootsShares });

    await runPinata(["doctor", "--verbose"], context.harness.deps);

    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({
      status: "ok",
      detail: "the sandbox VM shares exactly the workspaceRoot, the session dir and pinata's vm dir",
    });
  });

  it("knows no coverage before colima wrote the instance config", async () => {
    const context = await launchWith();

    await rm(join(context.paths.home, ".colima", "_lima", "colima-pi-sandbox", "lima.yaml"));

    expect(await context.harness.deps.backend().vm.coverage([])).toBeUndefined();
  });
});

const launchWithRoot = async (setup: Omit<Setup, "config"> & { root?: (paths: Paths) => string } = {}) => {
  const context = await launchWith(setup);
  const workspaceRoot = (setup.root ?? (({ repoRoot }) => repoRoot))(context.paths);

  await context.harness.writeJson(context.harness.userConfigFile, { workspaceRoot });

  return context;
};

const stateBinds = (context: Awaited<ReturnType<typeof launchWith>>) =>
  context.fake.created
    .flatMap((container) => container.spec?.mounts ?? [])
    .filter((mount) => mount.kind === "bind" && mount.source.startsWith(`${context.paths.stateDir}/`))
    .map((mount) => mount.source);

describe("the VM shares with workspaceRoot set", () => {
  it("keeps covering shares while another launch is live and says they change later", async () => {
    const context = await launchWithRoot({
      lima: ({ home, stateDir, repoRoot }) => [
        { location: home, writable: true },
        { location: stateDir },
        { location: repoRoot, writable: true },
      ],
    });

    await holdOtherLaunch(context.harness.stateDir);

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual([]);
    expect(context.harness.stderr()).toContain(
      `pinata: the sandbox VM will change its shares to ${rootsLocations(context.paths)} (adds ${join(context.paths.home, ".pi", "agent", "sessions")}, ${join(context.paths.stateDir, "vm")}, drops ${context.paths.home}, ${context.paths.stateDir}) at the next launch with no other pi session running\n`,
    );
    expect(context.fake.created).toHaveLength(1);
  });

  it("refuses while another launch is live and the current shares miss the repository", async () => {
    const context = await launchWith();
    const { repoRoot } = context.paths;

    await holdOtherLaunch(context.harness.stateDir);

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        `pinata: ${repoRoot} is not shared with the sandbox VM; 1 pi session is running, and restarting the VM to change its shares to ${rootsLocations(context.paths)}${dropsHomeAndState(context.paths)} would end them`,
        `  hint: end them and run pi again, or share it yourself with colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false ${rootsMounts(context.paths)}`,
      ].join("\n"),
    );
    expect(context.colimaCalls()).toEqual([]);
    expect(context.fake.containers.size).toBe(0);
  });

  it("refuses a root that is the home dir before touching the VM", async () => {
    const context = await launchWithRoot({ root: ({ home }) => home });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pinata: config: workspaceRoot: ${context.paths.home} is the home dir or holds it`,
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("refuses a repository outside the root, naming it and the key", async () => {
    const context = await launchWithRoot({ root: ({ home }) => join(home, "code") });

    await mkdir(join(context.paths.home, "code"), { recursive: true });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pinata: ${context.paths.repoRoot} is outside the workspace root (workspaceRoot: ${join(context.paths.home, "code")})`,
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("binds nothing from the state dir outside its vm dir", async () => {
    const context = await launchWith({ lima: rootsShares });

    expect(await run0(context)).toBe(0);

    const binds = stateBinds(context);

    expect(binds.length).toBeGreaterThan(0);
    expect(binds.filter((source) => !source.startsWith(`${join(context.paths.stateDir, "vm")}/`))).toEqual(
      [],
    );
  });

  it("warns in pinata doctor while the VM still shares the home, without restarting it", async () => {
    const context = await launchWithRoot({
      lima: ({ home, stateDir, repoRoot }) => [
        { location: home, writable: true },
        { location: stateDir },
        { location: repoRoot, writable: true },
      ],
    });
    const { home, stateDir } = context.paths;

    await runPinata(["doctor", "--verbose"], context.harness.deps);

    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({
      status: "warn",
      detail: `the sandbox VM shares ${home}:w, ${stateDir}, which workspaceRoot leaves out and lacks ~/.pi/agent/sessions:w, ${join(stateDir, "vm")}`,
      hint: "run pinata init, or pi, while no other pi session runs; either restarts the VM with the shares workspaceRoot sets",
    });
    expect(context.colimaCalls().filter((call) => /^colima (start|stop|restart)/.test(call))).toEqual([]);
  });

  it("passes pinata doctor when the VM shares exactly the configured set", async () => {
    const context = await launchWith({ lima: rootsShares });

    await runPinata(["doctor", "--verbose"], context.harness.deps);

    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({ status: "ok" });
  });
});

const foreignContainer = (fake: ReturnType<typeof createFakeBackend>, state: "running" | "stopped") =>
  fake.addContainer({
    name: "pi-sandbox-other",
    labels: {
      [LABELS.managed]: "true",
      [LABELS.install]: "otherinstall",
      [LABELS.role]: "agent",
      [LABELS.launchId]: "00000000000000ff",
      [LABELS.repoHash]: "f".repeat(64),
    },
    state,
    image: "sha256:other",
  });

const stoppedVm = () => {
  const vm = { up: false };
  const detect = async () => (vm.up ? { available: true } : { available: false, reason: "socket missing" });

  return { answers: { vm }, backend: { detect } };
};

describe("the VM shares with workspaceRoot set, at the edges", () => {
  it("counts a running launcher container of another agent dir as a live session and keeps the shares", async () => {
    const context = await launchWithRoot({
      lima: ({ home, stateDir, repoRoot }) => [
        { location: home, writable: true },
        { location: stateDir },
        { location: repoRoot, writable: true },
      ],
    });

    foreignContainer(context.fake, "running");

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual([]);
    expect(context.harness.stderr()).toContain("the sandbox VM will change its shares to ");
  });

  it("restarts the VM past a stopped launcher container of another agent dir", async () => {
    const context = await launchWith();

    foreignContainer(context.fake, "stopped");

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(restart(rootsMounts(context.paths)));
  });

  it("starts a stopped VM with the configured shares in one boot", async () => {
    const stopped = stoppedVm();
    const context = await launchWith(stopped);

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual([
      "colima status --profile pi-sandbox",
      `colima start --profile pi-sandbox --activate=false ${rootsMounts(context.paths)}`,
    ]);
    expect(context.fake.created).toHaveLength(1);
  });

  it("refuses before stopping the VM when the session dir lies inside a root", async () => {
    const context = await launchWith();
    const { home, repoRoot } = context.paths;
    const store = join(repoRoot, "sessions-store");

    await mkdir(store, { recursive: true });

    await symlink(store, join(home, ".pi", "agent", "sessions"));

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pinata: config: workspaceRoot: the sandbox VM shares ${repoRoot} and ${store}, which nest`,
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("restarts the VM to the planned set when lima.yaml does not parse", async () => {
    const context = await launchWith();

    await writeFile(limaYaml(context.paths.home), "mounts: [ { location: /x } ]\n");

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(restart(rootsMounts(context.paths)));
  });

  it("restarts the VM to the planned set when lima.yaml is missing", async () => {
    const context = await launchWith();

    await rm(limaYaml(context.paths.home));

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(restart(rootsMounts(context.paths)));
  });

  it("warns in pinata doctor when the shares cannot be read", async () => {
    const context = await launchWith();

    await writeFile(limaYaml(context.paths.home), "mounts: [ { location: /x } ]\n");

    await runPinata(["doctor", "--verbose"], context.harness.deps);

    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({
      status: "warn",
      detail:
        "colima's lima.yaml of profile pi-sandbox could not be read, so the shares of the sandbox VM are unknown",
    });
  });

  it("lets pinata doctor say a root does not exist", async () => {
    const context = await launchWithRoot({ lima: rootsShares, root: ({ root }) => join(root, "gone") });

    expect(await runPinata(["doctor"], context.harness.deps)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pinata: config: workspaceRoot: ${join(context.paths.root, "gone")} does not exist`,
    );
    expect(context.colimaCalls().filter((call) => /^colima (start|stop|restart)/.test(call))).toEqual([]);
  });

  it("lets pinata doctor leave the VM stopped while workspaceRoot is not set", async () => {
    const context = await launchWith({ workspaceRoot: false, answers: { vm: { up: false } } });

    expect(await runPinata(["doctor"], context.harness.deps)).toBe(0);
    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({
      status: "skip",
      detail: "workspaceRoot is not set, so there are no shares to check",
    });
    expect(doctorCheck(context.harness.stdout(), "sandbox")).toMatchObject({
      status: "skip",
      detail: "not started: workspaceRoot is not set, so the VM was not started",
    });
    expect(context.colimaCalls().filter((call) => /^colima (start|stop|restart)/.test(call))).toEqual([]);
  });

  it("names the workspace root on the vm line of the default view, and hides vm shares when another vm check warns", async () => {
    const merged = await launchWith({ lima: rootsShares });

    await runPinata(["doctor"], merged.harness.deps);

    expect(doctorCheck(merged.harness.stdout(), "vm")?.detail).toContain("shares the workspace root");

    const small = await launchWith({
      lima: rootsShares,
      vm: { size: async () => ({ cpus: 2, memoryGiB: 4 }) },
    });

    await runPinata(["doctor"], small.harness.deps);

    const stdout = small.harness.stdout();

    expect(doctorCheck(stdout, "vm")).toBeUndefined();
    expect(doctorCheck(stdout, "vm size")?.status).toBe("warn");
    expect(doctorCheck(stdout, "vm shares")).toBeUndefined();
  });
});
