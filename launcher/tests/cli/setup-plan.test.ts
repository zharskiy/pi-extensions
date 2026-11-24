import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmShare } from "../../backend/index.ts";
import {
  answersForYes,
  editedConfig,
  firstRunSteps,
  initialAnswers,
  isFirstRun,
  isPlanEmpty,
  NO_ROOT,
  ownedProblems,
  planOf,
  vmActionOf,
  vmBounds,
} from "../../cli/setup/plan.ts";
import type { Answers, FolderCandidate, HostFacts } from "../../cli/setup/types.ts";
import { tempDir } from "../support/temp-dir.ts";
import {
  AUTOMATIC_SIZE,
  candidateOf,
  documentOf as fixtureDocument,
  factsOf as fixtureFacts,
  HOME,
  runningVm,
} from "./setup-fixtures.ts";

const FILE = "/c/config.json";

const documentOf = (value: unknown, file = FILE) =>
  fixtureDocument(value === undefined ? undefined : `${JSON.stringify(value, null, 2)}\n`, file);

const candidate = (stored: string, origin: FolderCandidate["origin"], repos = 0) =>
  candidateOf({ stored, resolved: `${HOME}/${stored.slice(2)}`, origin, repos });

const factsOf = (overrides: Partial<HostFacts> = {}) => fixtureFacts({ configFile: FILE, ...overrides });

const WORK = [{ location: `${HOME}/work`, writable: true }];

const running = (size = AUTOMATIC_SIZE, shares: VmShare[] | "unreadable" = WORK) => runningVm(size, shares);

const answersOf = (overrides: Partial<Answers> = {}): Answers => ({
  root: "~/work",
  vm: "automatic",
  writeBack: true,
  ...overrides,
});

const SHARE = { shares: WORK };

const ENV = {};

describe("first run", () => {
  it("is a file without workspaceRoot, with the three steps as data", () => {
    expect(isFirstRun(documentOf(undefined))).toBe(true);
    expect(isFirstRun(documentOf({ egress: { allow: [] } }))).toBe(true);
    expect(isFirstRun(documentOf({ workspaceRoot: "~/w" }))).toBe(false);
    expect(firstRunSteps(documentOf(undefined))).toEqual(["folders", "vm", "writeBack"]);
    expect(firstRunSteps(documentOf({ workspaceRoot: "~/w" }))).toEqual([]);
  });
});

describe("ownedProblems", () => {
  it("names a bad vm value, a refused root and a container limit above the VM", async () => {
    const home = await realpath(await tempDir("plan-home"));
    const context = { home, env: { PI_CODING_AGENT_DIR: join(home, "agent") } };
    const document = documentOf({
      workspaceRoot: "~/.ssh/keys",
      vm: { memoryGiB: 1, cpus: 2 },
      resources: { cpus: 4 },
      writeBack: { enabled: true },
    });

    expect(ownedProblems(document, context)).toEqual([
      {
        key: "workspaceRoot",
        message: "~/.ssh/keys lies inside ~/.ssh, which the sandbox must never see.",
      },
      { key: "vm.cpus", message: expect.stringContaining("resources.cpus 4 is larger than vm.cpus 2") },
      { key: "vm.memoryGiB", message: "config: vm.memoryGiB must be at least 2" },
    ]);
  });

  it("names a workspaceRoot of the wrong shape, and the home", () => {
    const context = { home: "/Users/me", env: ENV };

    expect(ownedProblems(documentOf({ workspaceRoot: ["~/w"] }), context)).toEqual([
      { key: "workspaceRoot", message: expect.stringContaining("config: workspaceRoot") },
    ]);
    expect(ownedProblems(documentOf({ workspaceRoot: "~" }), context)).toEqual([
      {
        key: "workspaceRoot",
        message: "config: workspaceRoot ~ is the home dir, which would share all of it with the sandbox VM",
      },
    ]);
    expect(ownedProblems(documentOf({ workspaceRoot: "/Users" }), context)).toEqual([
      {
        key: "workspaceRoot",
        message:
          "/Users is your home or holds it, and the sandbox VM must not see all of it. Choose the folder in it that holds your projects.",
      },
    ]);
  });
});

describe("initialAnswers", () => {
  const CANDIDATES = [
    candidate("~/env", "env"),
    candidate("~/here", "cwd"),
    candidate("~/Projects", "usual", 3),
    candidate("~/src", "usual"),
  ];

  it("picks the env root, else the cwd folder, else a usual folder with repositories, on a first run", () => {
    expect(initialAnswers(documentOf(undefined), factsOf({ candidates: CANDIDATES }), ENV)).toEqual({
      root: "~/env",
      vm: "automatic",
      writeBack: true,
    });
    expect(
      initialAnswers(documentOf(undefined), factsOf({ candidates: CANDIDATES.slice(1) }), ENV).root,
    ).toBe("~/here");
    expect(initialAnswers(documentOf(undefined), factsOf(), ENV).root).toBeUndefined();
  });

  it("picks a detected folder when an existing file has no root, never an empty usual one", () => {
    const usual = [candidate("~/src", "usual"), candidate("~/Projects", "usual", 3)];

    expect(initialAnswers(documentOf({}), factsOf({ candidates: usual }), ENV).root).toBe("~/Projects");
    expect(
      initialAnswers(documentOf({ egress: { allow: [] } }), factsOf({ candidates: usual.slice(0, 1) }), ENV)
        .root,
    ).toBeUndefined();
  });

  it("starts a re-run from the file and replaces invalid owned values", () => {
    expect(
      initialAnswers(
        documentOf({ workspaceRoot: "~/w", vm: { cpus: 4 }, writeBack: { enabled: false } }),
        factsOf(),
        ENV,
      ),
    ).toEqual({ root: "~/w", vm: { kept: { cpus: 4 } }, writeBack: false });
    expect(
      initialAnswers(
        documentOf({ workspaceRoot: "~" }),
        factsOf({ candidates: [candidate("~/Projects", "usual", 3)] }),
        ENV,
      ).root,
    ).toBe("~/Projects");
    expect(
      initialAnswers(documentOf({ workspaceRoot: "~/w", vm: { cpus: 4, memoryGiB: 1 } }), factsOf(), ENV).vm,
    ).toEqual({ kept: { cpus: 4 } });
    expect(initialAnswers(documentOf({ vm: { memoryGiB: -3 } }), factsOf(), ENV).vm).toBe("automatic");
  });

  it("removes only the invalid VM key and keeps an untouched Automatic automatic", () => {
    const document = documentOf({ workspaceRoot: "~/w", vm: { cpus: 4, memoryGiB: 1 } });
    const answers = initialAnswers(document, factsOf(), ENV);

    expect(editedConfig(document.value, answers).vm).toEqual({ cpus: 4 });
    expect(editedConfig({ vm: { memoryGiB: -3 } }, { ...answers, vm: "automatic" }).vm).toBeUndefined();
  });
});

describe("vmActionOf", () => {
  const custom = { cpus: 8, memoryGiB: 12, diskGiB: 60 };

  it.each<[string, Partial<HostFacts>, Answers, unknown]>([
    ["absent", {}, answersOf(), { kind: "create", size: AUTOMATIC_SIZE, shares: WORK }],
    ["absent, custom", {}, answersOf({ vm: custom }), { kind: "create", size: custom, shares: WORK }],
    ["running and equal", { vm: running() }, answersOf(), { kind: "none" }],
    [
      "running, automatic at another size",
      { vm: running({ cpus: 2, memoryGiB: 4, diskGiB: 60 }) },
      answersOf(),
      { kind: "none" },
    ],
    [
      "running, size differs",
      { vm: running() },
      answersOf({ vm: custom }),
      { kind: "restart", size: custom, shares: WORK, parts: ["size"] },
    ],
    [
      "running, shares differ",
      { vm: running(AUTOMATIC_SIZE, [{ location: "/Users/me", writable: true }]) },
      answersOf(),
      { kind: "restart", size: AUTOMATIC_SIZE, shares: WORK, parts: ["folders"] },
    ],
    [
      "running, disk grows",
      { vm: running() },
      answersOf({ vm: { kept: { diskGiB: 100 } } }),
      {
        kind: "restart",
        size: { ...AUTOMATIC_SIZE, diskGiB: 100 },
        shares: WORK,
        parts: ["size"],
      },
    ],
    [
      "running, disk would shrink",
      { vm: running() },
      answersOf({ vm: { kept: { diskGiB: 40 } } }),
      { kind: "none" },
    ],
    [
      "sessions live",
      { vm: running(), sessions: 2 },
      answersOf({ vm: custom }),
      { kind: "defer", sessions: 2, parts: ["size"] },
    ],
    [
      "stopped and different",
      { vm: { state: "stopped", size: AUTOMATIC_SIZE, shares: "unreadable" } },
      answersOf({ vm: custom }),
      { kind: "on-next-start", parts: ["size", "folders"] },
    ],
    [
      "unknown",
      { vm: { state: "unknown", reason: "colima is not installed" } },
      answersOf(),
      { kind: "unknown", reason: "colima is not installed" },
    ],
  ])("%s", (_name, facts, answers, action) => {
    expect(vmActionOf(answers, factsOf(facts), SHARE)).toEqual(action);
  });

  it("restarts for a share the VM has and the plan does not", () => {
    const wider = running(AUTOMATIC_SIZE, [...WORK, { location: "/Volumes/x", writable: true }]);

    expect(vmActionOf(answersOf(), factsOf({ vm: wider }), SHARE)).toMatchObject({
      kind: "restart",
      parts: ["folders"],
    });
  });
});

describe("planOf", () => {
  it("gives the next file, its changes and the VM action", () => {
    const plan = planOf(documentOf(undefined), answersOf(), factsOf(), SHARE);

    expect(plan).toEqual({
      next: { workspaceRoot: "~/work" },
      text: '{\n  "workspaceRoot": "~/work"\n}\n',
      changes: [{ key: "workspaceRoot", kind: "add", after: "~/work" }],
      reindented: false,
      vm: { kind: "create", size: AUTOMATIC_SIZE, shares: WORK },
      problems: [],
    });
    expect(isPlanEmpty(plan)).toBe(false);
  });

  it("is empty when the file and the VM already match", () => {
    const document = documentOf({ workspaceRoot: "~/work" });

    expect(isPlanEmpty(planOf(document, answersOf(), factsOf({ vm: running() }), SHARE))).toBe(true);
  });

  it("carries the share problem, a missing root and an invalid result as problems", () => {
    expect(
      planOf(documentOf(undefined), answersOf(), factsOf(), { problem: "config: workspaceRoot: nest" }),
    ).toMatchObject({
      vm: { kind: "none" },
      problems: ["config: workspaceRoot: nest"],
    });
    expect(
      planOf(documentOf(undefined), answersOf({ root: undefined }), factsOf(), { problem: NO_ROOT }),
    ).toMatchObject({ next: {}, vm: { kind: "none" }, problems: [NO_ROOT] });
    expect(
      planOf(
        documentOf({ resources: { cpus: 8 } }),
        answersOf({ vm: { cpus: 4, memoryGiB: 8, diskGiB: 60 } }),
        factsOf(),
        SHARE,
      ).problems,
    ).toEqual([expect.stringContaining("resources.cpus 8 is larger than vm.cpus 4")]);
  });
});

describe("answersForYes", () => {
  const setup = async () => {
    const home = await realpath(await tempDir("yes-home"));

    await mkdir(join(home, "a"), { recursive: true });

    await mkdir(join(home, "b"), { recursive: true });

    return factsOf({ home, cwd: home });
  };

  it("takes PINATA_ROOT for a file without a root, a relative one from the cwd", async () => {
    const facts = await setup();

    expect(answersForYes(documentOf(undefined), facts, { PINATA_ROOT: "~/a/" })).toEqual({
      root: "~/a",
      vm: "automatic",
      writeBack: true,
    });
    expect(answersForYes(documentOf({}), facts, { PINATA_ROOT: "b" }).root).toBe(join(facts.home, "b"));
  });

  it("keeps the file's root and vm keys, also when PINATA_ROOT names the same folder", async () => {
    const facts = await setup();
    const document = documentOf({ workspaceRoot: "~/b", vm: { cpus: 4 } });

    expect(answersForYes(document, facts, { PINATA_ROOT: `${join(facts.home, "b")}/` })).toEqual({
      root: "~/b",
      vm: { kept: { cpus: 4 } },
      writeBack: true,
    });
    expect(answersForYes(document, facts, {}).root).toBe("~/b");
  });

  it("refuses another root, a refused root and a root of the wrong shape", async () => {
    const facts = await setup();

    expect(() => answersForYes(documentOf({ workspaceRoot: "~/a" }), facts, { PINATA_ROOT: "~/b" })).toThrow(
      "/c/config.json has another workspaceRoot than PINATA_ROOT",
    );
    expect(() => answersForYes(documentOf(undefined), facts, { PINATA_ROOT: "~" })).toThrow(
      "is the home dir or holds it",
    );
    expect(() => answersForYes(documentOf({ workspaceRoot: 1 }), facts, {})).toThrow("config: workspaceRoot");
  });

  it("refuses when neither the file nor PINATA_ROOT names a root", async () => {
    const facts = await setup();

    expect(() => answersForYes(documentOf({}), facts, {})).toThrow(
      "/c/config.json has no workspaceRoot and PINATA_ROOT is not set, so there is no folder to share with the sandbox VM",
    );
  });
});

describe("vmBounds", () => {
  it("bounds the fields by this Mac and the validator", () => {
    expect(vmBounds(factsOf())).toEqual({
      cpus: { min: 1, max: 12 },
      memoryGiB: { min: 2, max: 30 },
      diskGiB: { min: 20, max: 2048 },
    });
  });

  it("starts the disk at the VM's disk, which only grows", () => {
    expect(vmBounds(factsOf({ vm: running({ ...AUTOMATIC_SIZE, diskGiB: 100 }) })).diskGiB).toEqual({
      min: 100,
      max: 2048,
    });
  });

  it("keeps the minimums on a small Mac", () => {
    expect(vmBounds(factsOf({ cpus: 1, memoryGiB: 3 }))).toMatchObject({
      cpus: { min: 1, max: 1 },
      memoryGiB: { min: 2, max: 2 },
    });
  });
});
