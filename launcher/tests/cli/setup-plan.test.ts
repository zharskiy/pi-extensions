import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmShare } from "../../backend/index.ts";
import { readDocument } from "../../cli/setup/document.ts";
import {
  answersForYes,
  FIRST_RUN_STEPS,
  firstRunSteps,
  initialAnswers,
  isFirstRun,
  isPlanEmpty,
  ownedProblems,
  planOf,
  vmActionOf,
} from "../../cli/setup/plan.ts";
import type { Answers, ConfigDocument, FolderCandidate, HostFacts, VmFacts } from "../../cli/setup/types.ts";
import { tempDir } from "../support/temp-dir.ts";

const documentOf = (value: unknown, file = "/c/config.json"): ConfigDocument => {
  const read = readDocument(file, value === undefined ? undefined : `${JSON.stringify(value, null, 2)}\n`);

  if (!read.ok) {
    throw new Error(read.message);
  }

  return read.document;
};

const candidate = (stored: string, origin: FolderCandidate["origin"], repos = 0): FolderCandidate => ({
  stored,
  resolved: `/Users/me/${stored.slice(2)}`,
  exists: true,
  repos,
  capped: false,
  origin,
  here: false,
});

const SIZE = { cpus: 8, memoryGiB: 10, diskGiB: 60 };

const factsOf = (overrides: Partial<HostFacts> = {}): HostFacts => ({
  home: "/Users/me",
  cwd: "/Users/me",
  cpus: 12,
  memoryGiB: 32,
  freeDiskGiB: 412,
  automatic: SIZE,
  vm: { state: "absent" },
  sessions: 0,
  candidates: [],
  configFile: "/c/config.json",
  docsFile: "/l/CONFIGURATION.md",
  ...overrides,
});

const WORK = [{ location: "/Users/me/work", writable: true }];

const running = (size = SIZE, shares: VmShare[] | "unreadable" = WORK): VmFacts => ({
  state: "running",
  size,
  shares,
});

const answersOf = (overrides: Partial<Answers> = {}): Answers => ({
  roots: ["~/work"],
  vm: "automatic",
  writeBack: true,
  ...overrides,
});

const EXACT = { shares: WORK, exact: true };

const ENV = {};

describe("first run", () => {
  it("is a file without workspaceRoots, with the three steps as data", () => {
    expect(isFirstRun(documentOf(undefined))).toBe(true);
    expect(isFirstRun(documentOf({ egress: { allow: [] } }))).toBe(true);
    expect(isFirstRun(documentOf({ workspaceRoots: { roots: ["~/w"] } }))).toBe(false);
    expect(firstRunSteps(documentOf(undefined))).toEqual(["folders", "vm", "writeBack"]);
    expect(firstRunSteps(documentOf({ workspaceRoots: { roots: ["~/w"] } }))).toEqual([]);
    expect(FIRST_RUN_STEPS).toEqual(["folders", "vm", "writeBack"]);
  });
});

describe("ownedProblems", () => {
  it("names a bad vm value, a refused root and a container limit above the VM", async () => {
    const home = await realpath(await tempDir("plan-home"));
    const context = { home, env: { PI_CODING_AGENT_DIR: join(home, "agent") } };
    const document = documentOf({
      workspaceRoots: { roots: ["~/work", "~/.ssh/keys"] },
      vm: { memoryGiB: 1, cpus: 2 },
      resources: { cpus: 4 },
      writeBack: { enabled: true },
    });

    expect(ownedProblems(document, context)).toEqual([
      { key: "workspaceRoots.roots", message: expect.stringContaining("~/.ssh/keys overlaps") },
      { key: "vm.cpus", message: expect.stringContaining("resources.cpus 4 is larger than vm.cpus 2") },
      { key: "vm.memoryGiB", message: "config: vm.memoryGiB must be at least 2" },
    ]);
  });

  it("names a workspaceRoots of the wrong shape", () => {
    expect(
      ownedProblems(documentOf({ workspaceRoots: { roots: "~/w" } }), { home: "/Users/me", env: ENV }),
    ).toEqual([{ key: "workspaceRoots", message: "config: workspaceRoots.roots must be an array" }]);
  });
});

describe("initialAnswers", () => {
  const CANDIDATES = [
    candidate("~/env", "env"),
    candidate("~/here", "cwd"),
    candidate("~/Projects", "usual", 3),
    candidate("~/src", "usual"),
  ];

  it("pre-checks env roots, the cwd folder and usual folders with repositories on a first run", () => {
    expect(initialAnswers(documentOf(undefined), factsOf({ candidates: CANDIDATES }), ENV)).toEqual({
      roots: ["~/env", "~/here", "~/Projects"],
      vm: "automatic",
      writeBack: true,
    });
    expect(initialAnswers(documentOf(undefined), factsOf(), ENV).roots).toEqual([]);
  });

  it("keeps home sharing when an existing file has no roots", () => {
    const usual = [candidate("~/Projects", "usual", 3)];

    expect(initialAnswers(documentOf({}), factsOf({ candidates: usual }), ENV).roots).toBe("home");
  });

  it("starts a re-run from the file and replaces invalid owned values", () => {
    expect(
      initialAnswers(
        documentOf({ workspaceRoots: { roots: ["~/w"] }, vm: { cpus: 4 }, writeBack: { enabled: false } }),
        factsOf(),
        ENV,
      ),
    ).toEqual({ roots: ["~/w"], vm: { kept: { cpus: 4 } }, writeBack: false });
    expect(
      initialAnswers(
        documentOf({ workspaceRoots: { roots: ["~/w"] }, vm: { cpus: 4, memoryGiB: 1 } }),
        factsOf(),
        ENV,
      ).vm,
    ).toEqual({
      cpus: 4,
      memoryGiB: 10,
      diskGiB: 60,
    });
  });
});

describe("vmActionOf", () => {
  const custom = { cpus: 8, memoryGiB: 12, diskGiB: 60 };

  it.each<[string, Partial<HostFacts>, Answers, unknown]>([
    ["absent", {}, answersOf(), { kind: "create", size: SIZE, shares: WORK }],
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
      { kind: "restart", size: custom, shares: WORK, exactShares: true, parts: ["size"] },
    ],
    [
      "running, shares differ",
      { vm: running(SIZE, [{ location: "/Users/me", writable: true }]) },
      answersOf(),
      { kind: "restart", size: SIZE, shares: WORK, exactShares: true, parts: ["folders"] },
    ],
    [
      "running, disk grows",
      { vm: running() },
      answersOf({ vm: { kept: { diskGiB: 100 } } }),
      { kind: "restart", size: { ...SIZE, diskGiB: 100 }, shares: WORK, exactShares: true, parts: ["size"] },
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
      { vm: { state: "stopped", size: SIZE, shares: "unreadable" } },
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
    expect(vmActionOf(answers, factsOf(facts), EXACT)).toEqual(action);
  });

  it("asks only for missing shares when the shares need not be exact", () => {
    const wider = running(SIZE, [...WORK, { location: "/Volumes/x", writable: true }]);

    expect(vmActionOf(answersOf(), factsOf({ vm: wider }), { shares: WORK, exact: false })).toEqual({
      kind: "none",
    });
    expect(vmActionOf(answersOf(), factsOf({ vm: wider }), EXACT)).toMatchObject({
      kind: "restart",
      parts: ["folders"],
    });
  });
});

describe("planOf", () => {
  it("gives the next file, its changes and the VM action", () => {
    const plan = planOf(documentOf(undefined), answersOf(), factsOf(), EXACT);

    expect(plan).toEqual({
      next: { workspaceRoots: { roots: ["~/work"] } },
      text: '{\n  "workspaceRoots": {\n    "roots": [\n      "~/work"\n    ]\n  }\n}\n',
      changes: [{ key: "workspaceRoots.roots", kind: "add", after: ["~/work"] }],
      reindented: false,
      vm: { kind: "create", size: SIZE, shares: WORK },
      problems: [],
    });
    expect(isPlanEmpty(plan)).toBe(false);
  });

  it("is empty when the file and the VM already match", () => {
    const document = documentOf({ workspaceRoots: { roots: ["~/work"] } });

    expect(isPlanEmpty(planOf(document, answersOf(), factsOf({ vm: running() }), EXACT))).toBe(true);
  });

  it("carries the share problem, an empty folder list and an invalid result as problems", () => {
    expect(
      planOf(documentOf(undefined), answersOf(), factsOf(), { problem: "config: workspaceRoots: nest" }),
    ).toMatchObject({
      vm: { kind: "none" },
      problems: ["config: workspaceRoots: nest"],
    });
    expect(planOf(documentOf(undefined), answersOf({ roots: [] }), factsOf(), EXACT).problems).toEqual([
      "choose at least one project folder, or share your home",
    ]);
    expect(
      planOf(
        documentOf({ resources: { cpus: 8 } }),
        answersOf({ vm: { cpus: 4, memoryGiB: 8, diskGiB: 60 } }),
        factsOf(),
        EXACT,
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

  it("takes PI_SANDBOX_ROOTS for a file without roots, relative ones from the cwd", async () => {
    const facts = await setup();

    expect(answersForYes(documentOf(undefined), facts, { PI_SANDBOX_ROOTS: "~/a:b" })).toEqual({
      answers: { roots: ["~/a", join(facts.home, "b")], vm: "automatic", writeBack: true },
      notices: [],
    });
  });

  it("keeps the file's roots and vm keys, also when PI_SANDBOX_ROOTS names the same set", async () => {
    const facts = await setup();
    const document = documentOf({ workspaceRoots: { roots: ["~/b", "~/a"] }, vm: { cpus: 4 } });

    expect(
      answersForYes(document, facts, { PI_SANDBOX_ROOTS: `${join(facts.home, "a")}:~/b/` }).answers,
    ).toEqual({
      roots: ["~/b", "~/a"],
      vm: { kept: { cpus: 4 } },
      writeBack: true,
    });
  });

  it("refuses a different set, refused roots and roots of the wrong shape", async () => {
    const facts = await setup();

    expect(() =>
      answersForYes(documentOf({ workspaceRoots: { roots: ["~/a"] } }), facts, { PI_SANDBOX_ROOTS: "~/b" }),
    ).toThrow("/c/config.json has other workspaceRoots than PI_SANDBOX_ROOTS");
    expect(() => answersForYes(documentOf(undefined), facts, { PI_SANDBOX_ROOTS: "~" })).toThrow(
      "is the home dir or holds it",
    );
    expect(() => answersForYes(documentOf({ workspaceRoots: { roots: 1 } }), facts, {})).toThrow(
      "config: workspaceRoots.roots must be an array",
    );
  });

  it("shares the home with a notice when nothing names roots", async () => {
    const facts = await setup();

    expect(answersForYes(documentOf({}), facts, {})).toEqual({
      answers: { roots: "home", vm: "automatic", writeBack: true },
      notices: [
        "no workspaceRoots, so the sandbox VM shares your whole home; run pi sandbox init in a terminal to choose project folders",
      ],
    });
  });
});
