import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vmSharesOf } from "../../backend/colima/colima-yaml.ts";
import { shareFor } from "../../backend/colima/shares.ts";
import { createColimaVm } from "../../backend/colima/vm.ts";
import type { Backend } from "../../backend/index.ts";
import { run } from "../../cli/index.ts";
import { registerLaunch } from "../../grants/index.ts";
import { processMark, sha256Hex } from "../../shared/index.ts";
import {
  colimaYamlPath,
  createHarness,
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
  saved?: (paths: Paths) => YamlMount[];
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

  await writeColimaMounts(paths.home, (setup.saved ?? setup.lima ?? homeAndState)(paths));

  if (setup.config !== undefined) {
    await harness.writeJson(harness.userConfigFile, setup.config);
  }

  return {
    harness,
    fake,
    paths,
    pauses,
    colimaCalls: () =>
      harness.calls.filter((call) => call.file === "colima").map((call) => argvOf(call).join(" ")),
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
});

describe("shareFor", () => {
  const home = "/Users/dev";

  it("shares the volume root under /Volumes and the parent folder elsewhere", () => {
    expect(shareFor("/Volumes/Projects/a/b", home)).toBe("/Volumes/Projects");
    expect(shareFor("/opt/src/repo", home)).toBe("/opt/src");
    expect(shareFor("/private/tmp/x", home)).toBe("/private/tmp");
  });

  it("shares the home itself for a path inside it", () => {
    expect(shareFor("/Users/dev/.local/state/pi-sandbox", home)).toBe("/Users/dev");
  });

  it("shares the path itself when the parent is shallow, holds the home or holds a share", () => {
    expect(shareFor("/opt/repo", home)).toBe("/opt/repo");
    expect(shareFor("/Users/other", home)).toBe("/Users/other");
    expect(shareFor("/srv/a/repo", home, [{ location: "/srv/a/data", writable: false }])).toBe("/srv/a/repo");
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

  it("writes the implicit home share out when colima.yaml has an empty list", async () => {
    const context = await launchWith({ saved: () => [] });
    const { home, stateDir, repoRoot } = context.paths;

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(
      restart(`--mount ${home}:w --mount ${repoRoot}:w --mount ${stateDir}`),
    );
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

  it("takes an empty mountPoint as a plain mount", async () => {
    const context = await launchWith({
      saved: ({ home, stateDir }) => [
        { location: home, writable: true, mountPoint: '""' },
        { location: stateDir, mountPoint: "null" },
      ],
    });
    const { home, stateDir, repoRoot } = context.paths;

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(
      restart(`--mount ${home}:w --mount ${stateDir} --mount ${repoRoot}:w`),
    );
  });

  it("merges paths under one share and adds a read-only share for a read-only path", async () => {
    const context = await launchWith();
    const { home, stateDir, repoRoot, root } = context.paths;
    const docs = join(repoRoot, "docs");
    const reference = join(root, "data", "reference");

    await Promise.all([docs, reference].map((dir) => context.harness.writeJson(join(dir, "keep.json"), {})));

    await context.harness.writeJson(context.harness.userConfigFile, {
      mounts: { extraReadOnly: [docs, reference] },
    });

    expect(await run0(context)).toBe(0);
    expect(context.colimaCalls()).toEqual(
      restart(`--mount ${home}:w --mount ${stateDir} --mount ${repoRoot}:w --mount ${join(root, "data")}`),
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
        `  hint: end them and run pi again, or share it yourself with colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false --mount ${home}:w --mount ${stateDir} --mount ${repoRoot}:w; or run pi --no-sandbox to use host pi`,
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

  it("refuses a colima.yaml mount with keys the flags cannot express, before stopping the VM", async () => {
    const context = await launchWith({
      saved: ({ home }) => [{ location: home, writable: true, mountPoint: "/mnt/home" }],
    });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      "  hint: edit ~/.colima/pi-sandbox/colima.yaml mounts, then colima stop --profile pi-sandbox && colima start --profile pi-sandbox --activate=false",
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("refuses when a share the VM has now would be dropped by the saved list", async () => {
    const context = await launchWith({
      lima: ({ home, stateDir, root }) => [
        ...homeAndState({ home, stateDir } as Paths),
        { location: join(root, "extra") },
      ],
      saved: homeAndState,
    });
    const { repoRoot, root } = context.paths;

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toContain(
      `pi-sandbox: sharing ${repoRoot} would drop ${join(root, "extra")} from the sandbox VM; refusing\n  hint: edit ~/.colima/pi-sandbox/colima.yaml mounts`,
    );
    expect(context.colimaCalls()).toEqual([]);
  });

  it("refuses without a readable colima.yaml list: missing, or a flow-style list", async () => {
    const missing = await launchWith();
    const flow = await launchWith();

    await rm(colimaYamlPath(missing.paths.home));

    await writeFile(
      colimaYamlPath(flow.paths.home),
      `mounts: [{location: ${flow.paths.home}, writable: true}, {location: /Volumes/X, writable: true}]\n`,
    );

    expect(await run0(missing)).toBe(1);
    expect(await run0(flow)).toBe(1);
    expect(missing.harness.stderr()).toContain(
      `pi-sandbox: ${missing.paths.repoRoot} is not shared with the sandbox VM; the launcher cannot read the mounts of ~/.colima/pi-sandbox/colima.yaml\n`,
    );
    expect(flow.harness.stderr()).toContain(
      "the launcher cannot read the mounts of ~/.colima/pi-sandbox/colima.yaml",
    );
    expect([...missing.colimaCalls(), ...flow.colimaCalls()]).toEqual([]);
  });

  it("adds no --no-sandbox suffix to a refusal under fallback refuse", async () => {
    const context = await launchWith({ config: { fallback: "refuse" } });

    await registerLaunch(context.harness.stateDir, {
      launchId: "00000000000000ee",
      ...(await processMark()),
      repoHash: sha256Hex("/elsewhere"),
      startedAt: 1,
    });

    expect(await run0(context)).toBe(1);
    expect(context.harness.stderr()).toMatch(/hint: end them and run pi again, .* --mount \S+:w\n$/);
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
    expect(detections.count).toBe(6);
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

    expect(context.harness.stdout()).toContain(
      `warn vm shares: the sandbox VM does not share ${context.paths.repoRoot}; the next pi here shares it, restarting the VM once no pi session runs`,
    );
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

    expect(context.harness.stdout()).toContain(
      "ok vm shares: the sandbox VM shares every path this repository needs",
    );
  });

  it("knows no coverage before colima wrote the instance config", async () => {
    const context = await launchWith();

    await rm(join(context.paths.home, ".colima", "_lima", "colima-pi-sandbox", "lima.yaml"));

    expect(await context.harness.deps.backend().vm.coverage([])).toBeUndefined();
  });
});
