import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vmSharesOf } from "../../backend/colima/colima-yaml.ts";
import { createColimaShares, shareFor } from "../../backend/colima/shares.ts";
import { createColimaVm } from "../../backend/colima/vm.ts";
import type { Backend } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
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
import { tempDir } from "../support/temp-dir.ts";

const PROFILE = { status: async () => ({ socket: "/fake/docker.sock", profile: "pi-sandbox" }) };

interface ColimaAnswers {
  start?: { code: number; stderr: string };
  keepLima?: boolean;
  missing?: boolean;
}

const mountsOf = (args: string[]): YamlMount[] =>
  args.flatMap((arg, index) => {
    if (args[index - 1] !== "--mount") {
      return [];
    }

    return arg.endsWith(":w") ? [{ location: arg.slice(0, -2), writable: true }] : [{ location: arg }];
  });

const answerColima = async (home: string, answers: ColimaAnswers, call: FakeCall) => {
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
  config?: unknown;
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

      return { ...backend, vm };
    },
    respond: (call) => colima(holder.home, answers)(call),
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

  it("reads a null list as no share and an entry it cannot parse as unknown", () => {
    expect(vmSharesOf("mounts: null\n", home)).toEqual([]);
    expect(
      vmSharesOf(`mounts:\n  - location: ${home}\n  - {location: /opt/x, writable: true}\n`, home),
    ).toBeUndefined();
  });
});

describe("shareFor", () => {
  const home = "/Users/dev";

  it("shares the volume root under /Volumes and the parent folder elsewhere", () => {
    expect(shareFor("/Volumes/Projects/a/b", home)).toBe("/Volumes/Projects");
    expect(shareFor("/opt/src/repo", home)).toBe("/opt/src");
    expect(shareFor("/private/tmp/x", home)).toBe("/private/tmp");
  });

  it("shares the home itself for a path inside it", () => {
    expect(shareFor("/Users/dev/.pi/agent/pi-sandbox/state", home)).toBe("/Users/dev");
  });

  it("shares the path itself when the parent is shallow or holds the home", () => {
    expect(shareFor("/opt/repo", home)).toBe("/opt/repo");
    expect(shareFor("/Users/other", home)).toBe("/Users/other");
  });
});

const limaPath = (home: string) => join(home, ".colima", "_lima", "colima-pi-sandbox", "lima.yaml");

const sharesWith = async (lima: string) => {
  const home = await tempDir("shares");
  const calls: string[][] = [];

  await writeLimaMounts(home, []);

  await writeFile(limaPath(home), lima);

  const shares = createColimaShares({
    home,
    profile: "pi-sandbox",
    run: async (_failure, args) => {
      calls.push(args);
    },
    detectAgain: async () => ({ available: true }),
    withLock: (action) => action(),
  });
  const mounts = () => (calls.at(-1) ?? []).filter((_arg, index, all) => all[index - 1] === "--mount");

  return { shares, mounts };
};

const yamlList = (mounts: Array<[string, boolean | string]>) =>
  `mounts:\n${mounts.map(([location, writable]) => `  - location: ${location}\n    writable: ${writable}\n`).join("")}`;

const idle = { busy: async () => 0, report: () => undefined };

describe("the share plan", () => {
  it("merges paths under one share, read-only unless one of them must be writable", async () => {
    const readOnly = await sharesWith(yamlList([["/opt/tools", true]]));
    const mixed = await sharesWith(yamlList([["/opt/tools", true]]));

    await readOnly.shares
      .ensureShares(
        [
          { path: "/srv/data/a", writable: false },
          { path: "/srv/data/b", writable: false },
        ],
        idle,
      )
      .catch(() => undefined);
    await mixed.shares
      .ensureShares(
        [
          { path: "/srv/data/a", writable: false },
          { path: "/srv/data/b", writable: true },
        ],
        idle,
      )
      .catch(() => undefined);

    expect(readOnly.mounts()).toEqual(["/opt/tools:w", "/srv/data"]);
    expect(mixed.mounts()).toEqual(["/opt/tools:w", "/srv/data:w"]);
  });

  it("absorbs a share inside a new one instead of nesting them", async () => {
    const child = await sharesWith(yamlList([["/Users/Shared/code", true]]));
    const readOnly = await sharesWith(yamlList([["/opt/ref", false]]));
    const volume = await sharesWith(yamlList([["/Volumes/USB/sub", true]]));

    await child.shares.ensureShares([{ path: "/Users/Shared", writable: true }], idle).catch(() => undefined);
    await readOnly.shares
      .ensureShares([{ path: "/opt/ref/a/repo", writable: true }], idle)
      .catch(() => undefined);
    await volume.shares.ensureShares([{ path: "/Volumes/USB", writable: true }], idle).catch(() => undefined);

    expect(child.mounts()).toEqual(["/Users/Shared:w"]);
    expect(readOnly.mounts()).toEqual(["/opt/ref:w"]);
    expect(volume.mounts()).toEqual(["/Volumes/USB:w"]);
  });
});

describe("the launch shares a repository the VM does not see", () => {
  it("launches without asking colima when every path is shared", async () => {
    const context = await launchWith({ lima: ({ root }) => [{ location: root, writable: true }] });

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual([]);
    expect(context.harness.stderr()).not.toContain("with the sandbox VM");
    expect(context.fake.created).toHaveLength(1);
  });

  it("restarts the VM with the full mount list and prints one notice", async () => {
    const context = await launchWith();
    const { home, stateDir, repoRoot } = context.paths;

    expect(await run0(context)).toBe(0);
    expect(context.harness.stderr()).toContain(
      `pi-sandbox: sharing ${repoRoot} with the sandbox VM, one time\n`,
    );
    expect(context.colimaCalls()).toEqual(
      restart(`--mount ${home}:w --mount ${stateDir} --mount ${repoRoot}:w`),
    );
    expect(context.fake.created).toHaveLength(1);
  });

  it("shares the home again first when a bare --mount dropped it, for the session dir under it", async () => {
    const context = await launchWith({ lima: ({ repoRoot }) => [{ location: repoRoot, writable: true }] });
    const { home, stateDir, repoRoot } = context.paths;

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(
      restart(`--mount ${home}:w --mount ${repoRoot}:w --mount ${stateDir}`),
    );
  });

  it("upgrades a read-only share in place when a writable path needs it", async () => {
    const context = await launchWith({
      lima: ({ home, repoRoot, stateDir }) => [
        { location: home, writable: true },
        { location: repoRoot },
        { location: stateDir },
      ],
    });
    const { home, stateDir, repoRoot } = context.paths;

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(
      restart(`--mount ${home}:w --mount ${repoRoot}:w --mount ${stateDir}`),
    );
  });

  it("upgrades a read-only home for the session dir and keeps it read-only without one", async () => {
    const readOnlyHome = ({ home, stateDir }: Paths) => [{ location: home }, { location: stateDir }];
    const sessions = await launchWith({ lima: readOnlyHome });
    const plain = await launchWith({ lima: readOnlyHome, config: { sessions: { host: false } } });

    expect(await run0(sessions)).toBe(0);
    expect(await run0(plain)).toBe(0);
    expect(sessions.colimaCalls()).toEqual(
      restart(
        `--mount ${sessions.paths.home}:w --mount ${sessions.paths.stateDir} --mount ${sessions.paths.repoRoot}:w`,
      ),
    );
    expect(plain.colimaCalls()).toEqual(
      restart(
        `--mount ${plain.paths.home} --mount ${plain.paths.stateDir} --mount ${plain.paths.repoRoot}:w`,
      ),
    );
  });

  it("takes an empty mountPoint, or one at the share's own path, as a plain mount", async () => {
    const context = await launchWith({
      lima: ({ home, stateDir }) => [
        { location: home, writable: true, mountPoint: '""' },
        { location: stateDir, mountPoint: stateDir },
      ],
    });
    const { home, stateDir, repoRoot } = context.paths;

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(
      restart(`--mount ${home}:w --mount ${stateDir} --mount ${repoRoot}:w`),
    );
  });

  it("refuses with the full command while another pi session is live and leaves the VM alone", async () => {
    const context = await launchWith();
    const { home, stateDir, repoRoot } = context.paths;

    await registerLaunch(context.harness.stateDir, {
      launchId: "00000000000000dd",
      ...(await processMark()),
      repoHash: sha256Hex("/elsewhere"),
      startedAt: 1,
    });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        `pi-sandbox: ${repoRoot} is not shared with the sandbox VM; sharing ${repoRoot} restarts the VM and would stop 1 running pi session`,
        `  hint: end them and run pi again, or share it yourself with colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false --mount ${home}:w --mount ${stateDir} --mount ${repoRoot}:w`,
      ].join("\n"),
    );
    expect(context.colimaCalls()).toEqual([]);
    expect(context.fake.containers.size).toBe(0);
  });

  it("names the colima error when the start fails", async () => {
    const context = await launchWith({
      answers: { start: { code: 1, stderr: 'starting\nlevel=fatal msg="disk busy"\n' } },
    });
    const { repoRoot } = context.paths;

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      [
        `pi-sandbox: could not share ${repoRoot} with the sandbox VM: colima start failed: level=fatal msg="disk busy"`,
        "  hint: run colima start --profile pi-sandbox --activate=false and see ~/.colima/_lima/colima-pi-sandbox/ha.stderr.log",
      ].join("\n"),
    );
  });

  it("refuses when colima started without the share", async () => {
    const context = await launchWith({ answers: { keepLima: true } });
    const { repoRoot } = context.paths;

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pi-sandbox: colima did not share ${repoRoot} with the sandbox VM\n`,
    );
    expect(context.fake.containers.size).toBe(0);
  });

  it("refuses a share mounted at another path in the VM, before stopping the VM", async () => {
    const context = await launchWith({
      lima: ({ home }) => [{ location: home, writable: true, mountPoint: "/mnt/home" }],
    });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `; ${context.paths.home} is mounted at another path in the VM, which colima's --mount cannot keep\n`,
    );
    expect(context.harness.stderr()).toContain(
      "  hint: edit ~/.colima/pi-sandbox/colima.yaml mounts, then colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false",
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("names the missing colima", async () => {
    const context = await launchWith({ answers: { missing: true } });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pi-sandbox: could not share ${context.paths.repoRoot} with the sandbox VM: colima: command not found\n`,
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
      `pi-sandbox: the sandbox VM did not come back after sharing ${context.paths.repoRoot}: socket missing\n`,
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

  it("lets pi sandbox doctor name a path the VM lacks without sharing it or restarting the VM", async () => {
    const context = await launchWith();

    await run(["sandbox", "doctor"], context.harness.deps);

    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({
      status: "warn",
      detail: `the sandbox VM does not share ${context.paths.repoRoot}`,
      hint: "run pi once here while no other pi session runs, which shares it and restarts the VM, then pi sandbox doctor again",
    });
    expect(context.colimaCalls().filter((call) => /^colima (start|stop|restart)/.test(call))).toEqual([]);
  });

  it("lets pi sandbox doctor say the VM shares every path it needs", async () => {
    const context = await launchWith({
      lima: ({ home, stateDir, repoRoot }) => [
        { location: home, writable: true },
        { location: stateDir },
        { location: repoRoot, writable: true },
      ],
    });

    await run(["sandbox", "doctor"], context.harness.deps);

    expect(doctorCheck(context.harness.stdout(), "vm shares")).toMatchObject({
      status: "ok",
      detail: "the sandbox VM shares every path this repository needs",
    });
  });

  it("knows no coverage before colima wrote the instance config", async () => {
    const context = await launchWith();

    await rm(join(context.paths.home, ".colima", "_lima", "colima-pi-sandbox", "lima.yaml"));

    expect(await context.harness.deps.backend().vm.coverage([])).toBeUndefined();
  });
});
