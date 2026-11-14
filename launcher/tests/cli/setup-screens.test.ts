import { describe, expect, it } from "vitest";
import { vmBounds } from "../../cli/setup/plan.ts";
import {
  applyLines,
  automaticLabel,
  folderTag,
  hubRowLines,
  introLines,
  numberFields,
  rootsSummary,
  successLines,
  vmActionText,
  vmDoneLine,
  vmFailureLines,
  wrapped,
} from "../../cli/setup/screens.ts";
import type { FolderCandidate, HostFacts, Plan, VmAction } from "../../cli/setup/types.ts";

const HOME = "/Users/me";

const SIZE = { cpus: 8, memoryGiB: 10, diskGiB: 60 };

const FACTS: HostFacts = {
  home: HOME,
  cwd: HOME,
  cpus: 12,
  memoryGiB: 32,
  freeDiskGiB: 412,
  automatic: SIZE,
  vm: { state: "absent" },
  sessions: 0,
  candidates: [],
  configFile: `${HOME}/.pi/agent/pi-sandbox/config.json`,
  docsFile: "/opt/launcher/CONFIGURATION.md",
};

const RUNNING: HostFacts["vm"] = { state: "running", size: { ...SIZE, diskGiB: 100 }, shares: [] };

const candidate = (overrides: Partial<FolderCandidate>): FolderCandidate => ({
  stored: "~/x",
  resolved: `${HOME}/x`,
  exists: true,
  repos: 0,
  capped: false,
  origin: "usual",
  here: false,
  ...overrides,
});

const planOf = (overrides: Partial<Plan>): Plan => ({
  next: {},
  text: "{}\n",
  changes: [],
  reindented: false,
  vm: { kind: "none" },
  problems: [],
  ...overrides,
});

const SHAPE = { existed: true, indent: "  " };

describe("the intro", () => {
  it("names the VM state and the live sessions", () => {
    const facts = { ...FACTS, vm: RUNNING, sessions: 1 };

    expect(introLines(facts, false, false).slice(2)).toEqual([
      { label: "This Mac     ", text: "12 CPUs · 32 GiB memory · 412 GiB free disk" },
      { label: "Sandbox VM   ", text: "running · 8 CPUs · 10 GiB memory · 100 GiB disk" },
      "             1 pi session is running",
      "",
    ]);
  });

  it("leaves the free disk out when it is unknown, and says why the VM could not be checked", () => {
    const facts = {
      ...FACTS,
      freeDiskGiB: undefined,
      vm: { state: "unknown" as const, reason: "colima is not installed" },
    };

    expect(introLines(facts, true, true)).toEqual([
      "This Mac: 12 CPUs · 32 GiB memory",
      "Sandbox VM: could not be checked: colima is not installed",
      "Nothing is saved until you choose Apply.",
      "",
    ]);
  });
});

describe("the folder tags", () => {
  const many = candidate({ stored: "~/Projects", repos: 14 });
  const few = candidate({ stored: "~/work", repos: 3, origin: "cwd", here: true });
  const capped = candidate({ repos: 50, capped: true });
  const all = [many, few, capped];

  it("pads the counts so they line up, except in plain mode", () => {
    expect(folderTag(few, all, false)).toBe(" 3 git repositories · you are here");
    expect(folderTag(few, all, true)).toBe("3 git repositories · you are here");
    expect(folderTag(capped, all, false)).toBe("50+ git repositories");
    expect(folderTag(candidate({ repos: 1 }), [candidate({ repos: 1 })], false)).toBe("1 git repository");
    expect(folderTag(candidate({}), all, false)).toBe("no git repository found");
  });

  it("tags configured and environment roots by where they come from", () => {
    expect(folderTag(candidate({ origin: "config", exists: false }), all, false)).toBe(
      "current · not found right now",
    );
    expect(folderTag(candidate({ origin: "env" }), all, false)).toBe("from PI_SANDBOX_ROOTS");
  });

  it("summarises more than three roots", () => {
    expect(rootsSummary(["~/a", "~/b", "/Volumes/Code", "~/c", "~/d"])).toBe(
      "~/a, ~/b, /Volumes/Code and 2 more",
    );
    expect(rootsSummary("home")).toBe("your whole home (~), not recommended");
  });
});

describe("the hub", () => {
  const rows = [
    { label: "Project folders", value: "~/Projects", tag: "chosen" as const, problems: [] },
    {
      label: "VM size",
      value: "8 CPUs",
      tag: "invalid" as const,
      problems: ["config: vm.memoryGiB must be at least 2"],
    },
  ];

  it("aligns the labels and puts the tags at the right edge", () => {
    expect(hubRowLines(rows, 50 + 10, false)).toEqual([
      `Project folders      ~/Projects${" ".repeat(19)}chosen`,
      `VM size              8 CPUs${" ".repeat(22)}invalid`,
      "                     config: vm.memoryGiB must be at",
      "                     least 2",
    ]);
  });

  it("puts the values on their own lines below 60 columns", () => {
    expect(hubRowLines(rows, 50, false)).toEqual([
      `Project folders${" ".repeat(25)}chosen`,
      "  ~/Projects",
      `VM size${" ".repeat(32)}invalid`,
      "  8 CPUs",
      "  config: vm.memoryGiB must be at least 2",
    ]);
  });

  it("writes the rows as words in plain mode", () => {
    expect(hubRowLines(rows, 80, true)).toEqual([
      "  Project folders: ~/Projects (chosen)",
      "  VM size: 8 CPUs (invalid)",
    ]);
  });

  it("shows a change on two lines when it does not fit", () => {
    const plan = planOf({
      changes: [
        {
          key: "workspaceRoots.roots",
          kind: "change",
          before: ["~/Projects", "~/work"],
          after: ["~/Projects", "~/work", "~/oss"],
        },
        { key: "vm.cpus", kind: "remove", before: 6 },
      ],
      reindented: true,
    });

    expect(applyLines(plan, FACTS, SHAPE, 80, false)).toEqual([
      "When you apply:",
      "  • change ~/.pi/agent/pi-sandbox/config.json",
      '      ~ workspaceRoots.roots   ["~/Projects","~/work"]',
      '                               → ["~/Projects","~/work","~/oss"]',
      "      - vm.cpus                6   (back to automatic: 8)",
      "      (the rest of the file is kept; its indentation is normalised to 2",
      "      spaces)",
    ]);
  });

  it("says that removed roots share the whole home again", () => {
    const plan = planOf({ changes: [{ key: "workspaceRoots.roots", kind: "remove", before: ["~/a"] }] });

    expect(applyLines(plan, FACTS, SHAPE, 80, true)).toEqual([
      "When you apply:",
      "  - change ~/.pi/agent/pi-sandbox/config.json",
      "      removed workspaceRoots (your whole home is shared again)",
    ]);
  });

  it("notes that a write-back change applies from the next pi", () => {
    const plan = planOf({ changes: [{ key: "writeBack.enabled", kind: "add", after: false }] });

    expect(applyLines(plan, FACTS, { existed: false, indent: "\t" }, 80, false).slice(0, 2)).toEqual([
      "When you apply:",
      "  • create ~/.pi/agent/pi-sandbox/config.json (applies from the next pi)",
    ]);
  });

  it("words every VM action", () => {
    const actions: VmAction[] = [
      { kind: "restart", size: SIZE, shares: [], exactShares: true, parts: ["size", "folders"] },
      { kind: "defer", sessions: 2, parts: ["folders"] },
      { kind: "defer", sessions: 1, parts: ["size"] },
      { kind: "create", size: SIZE, shares: [{ location: "/Users/me", writable: true }] },
      { kind: "on-next-start", parts: ["size"] },
      { kind: "unknown", reason: "colima status failed" },
      { kind: "none" },
    ];

    expect(actions.map((action) => vmActionText(action, "/Users/me"))).toEqual([
      "restart the sandbox VM with the new size and folders; no pi session is running, and this usually takes under a minute",
      "keep the sandbox VM as it is for now: 2 pi sessions are running. The first pi you start after they all exit restarts it with the new folders",
      "keep the sandbox VM as it is for now: 1 pi session is running. The first pi you start after it exits restarts it with the new size",
      "create the sandbox VM sharing your whole home (~), writable; this takes a minute or two, longer the first time while colima downloads the VM's system image",
      "the sandbox VM is stopped; the next pi starts it with the new size",
      "the sandbox VM could not be checked (colima status failed); run pi sandbox doctor after applying",
      undefined,
    ]);
  });
});

describe("the VM size editor", () => {
  it("shows the VM's own disk when it is bigger than automatic", () => {
    expect(automaticLabel({ ...FACTS, vm: RUNNING })).toBe(
      "8 CPUs · 10 GiB memory · 100 GiB disk (the VM's disk only grows)",
    );
  });

  it("bounds and words the number fields", () => {
    const facts = { ...FACTS, vm: RUNNING };
    const fields = numberFields(facts, vmBounds(facts));

    expect(fields.cpus).toMatchObject({
      note: "this Mac has 12",
      hint: "1 to 12",
      tooHigh: "Choose 1 to 12 CPUs: this Mac has 12.",
    });
    expect(fields.memoryGiB.tooHigh).toBe(
      "Choose 2 to 30 GiB: this Mac has 32 GiB and macOS needs the rest.",
    );
    expect(fields.memoryGiB.warn(25)).toBe(
      "That leaves little memory for macOS. Press enter again to keep it.",
    );
    expect(fields.memoryGiB.warn(24)).toBeUndefined();
    expect(fields.diskGiB).toMatchObject({
      note: "412 GiB free on this Mac",
      hint: "100 to 2048 · the disk can only grow, it is 100 GiB now",
      tooLow: "The VM's disk is 100 GiB now and can only grow. Choose 100 or more.",
      tooHigh: "Choose at most 2048 GiB.",
    });
    expect(fields.diskGiB.warn(600)).toBe(
      "This Mac has 412 GiB free. The disk file grows only as the VM fills it. Press enter again to keep it.",
    );
  });
});

describe("the VM step", () => {
  const create: VmAction = { kind: "create", size: SIZE, shares: [] };
  const restart: VmAction = {
    kind: "restart",
    size: SIZE,
    shares: [],
    exactShares: true,
    parts: ["folders"],
  };

  it("words each result", () => {
    expect(vmDoneLine("created", create, "54s", false)).toBe(
      "✔ Created in 54s: 8 CPUs · 10 GiB memory · 60 GiB disk",
    );
    expect(vmDoneLine("restarted", restart, "31s", true)).toBe(
      "Restarted the VM in 31s with the new folders",
    );
    expect(vmDoneLine("unchanged", restart, "1s", false)).toBe("✔ Nothing to do: the VM already matches");
    expect(vmDoneLine({ deferred: 1 }, restart, "1s", false)).toMatch(/a pi session started meanwhile/);
  });

  it("names the verb and the last line of the error", () => {
    expect(vmFailureLines(restart, "1m 05s", "colima stop failed\nsome detail")).toEqual([
      "✖ Could not restart the VM after 1m 05s.",
      "  some detail",
    ]);
  });
});

describe("the success screen", () => {
  it("falls back to a placeholder project", () => {
    expect(successLines(["~/Projects"], FACTS, false, true)[1]).toBe(
      "Next: cd <a project in ~/Projects> && pi",
    );
    expect(successLines("home", FACTS, true, true).slice(0, 2)).toEqual([
      "Done. Settings saved.",
      "Next: cd <a project> && pi",
    ]);
  });
});

describe("wrapping", () => {
  it("indents the lines of an indented paragraph", () => {
    expect(wrapped([{ text: "one two three", indent: "  " }, ""], 9)).toEqual(["  one two", "  three", ""]);
  });
});
