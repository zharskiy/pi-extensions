import { describe, expect, it } from "vitest";
import type { VmApplied } from "../../backend/index.ts";
import { vmBounds } from "../../cli/setup/plan.ts";
import {
  applyLines,
  automaticLabel,
  eventLines,
  folderTag,
  hubRowLines,
  introLines,
  numberFields,
  rootSummary,
  vmActionText,
  vmCollapsed,
  wrapped,
} from "../../cli/setup/screens.ts";
import type { Answers, Plan, RunningVm, VmAction } from "../../cli/setup/types.ts";
import { AUTOMATIC_SIZE, candidateOf, factsOf, runningVm } from "./setup-fixtures.ts";

const FACTS = factsOf();

const RUNNING = runningVm({ ...AUTOMATIC_SIZE, diskGiB: 100 });

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
  const many = candidateOf({ stored: "~/Projects", repos: 14 });
  const few = candidateOf({ stored: "~/work", repos: 3, origin: "cwd", here: true });
  const capped = candidateOf({ repos: 50, capped: true });
  const all = [many, few, capped];

  it("pads the counts so they line up, except in plain mode", () => {
    expect(folderTag(few, all, false)).toBe(" 3 git repositories · you are here");
    expect(folderTag(few, all, true)).toBe("3 git repositories · you are here");
    expect(folderTag(capped, all, false)).toBe("50+ git repositories");
    expect(folderTag(candidateOf({ repos: 1 }), [candidateOf({ repos: 1 })], false)).toBe("1 git repository");
    expect(folderTag(candidateOf({}), all, false)).toBe("no git repository found");
  });

  it("tags configured and environment roots by where they come from", () => {
    expect(folderTag(candidateOf({ origin: "config", exists: false }), all, false)).toBe(
      "current · missing, not shared until it exists",
    );
    expect(folderTag(candidateOf({ origin: "env" }), all, false)).toBe("from PINATA_ROOT");
  });

  it("summarises the root, escaping it, and no root as none", () => {
    expect(rootSummary("/Volumes/Code")).toBe("/Volumes/Code");
    expect(rootSummary("~/a\u202e")).toBe("~/a\\u202E");
    expect(rootSummary(undefined)).toBe("none");
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
    expect(hubRowLines(rows, 56, false)).toEqual([
      `Project folders      ~/Projects${" ".repeat(19)}chosen`,
      `VM size              8 CPUs${" ".repeat(22)}invalid`,
      "                     config: vm.memoryGiB must be at",
      "                     least 2",
    ]);
  });

  it("puts the values on their own lines below 60 columns", () => {
    expect(hubRowLines(rows, 46, false)).toEqual([
      `Project folders${" ".repeat(25)}chosen`,
      "  ~/Projects",
      `VM size${" ".repeat(32)}invalid`,
      "  8 CPUs",
      "  config: vm.memoryGiB must be at least 2",
    ]);
  });

  it("writes the rows as words in plain mode", () => {
    expect(hubRowLines(rows, 76, true)).toEqual([
      "  Project folders: ~/Projects (chosen)",
      "  VM size: 8 CPUs (invalid)",
    ]);
  });

  it("shows a change on two lines when it does not fit", () => {
    const plan = planOf({
      changes: [
        {
          key: "image.packages",
          kind: "change",
          before: ["ripgrep", "imagemagick"],
          after: ["ripgrep", "imagemagick", "postgresql-client"],
        },
        { key: "vm.cpus", kind: "remove", before: 6 },
      ],
      reindented: true,
    });

    expect(applyLines(plan, FACTS, SHAPE, 76, false)).toEqual([
      "When you apply:",
      "  • change ~/.pi/agent/pinata/config.json",
      '      ~ image.packages   ["ripgrep","imagemagick"]',
      '                         → ["ripgrep","imagemagick","postgresql-client"]',
      "      - vm.cpus          6   (back to automatic: 8)",
      "      (the rest of the file is kept; its indentation is normalised to 2",
      "      spaces)",
    ]);
  });

  it("shows a new root as an added key", () => {
    const plan = planOf({ changes: [{ key: "workspaceRoot", kind: "add", after: "~/a" }] });

    expect(applyLines(plan, FACTS, SHAPE, 76, true)).toEqual([
      "When you apply:",
      "  - change ~/.pi/agent/pinata/config.json",
      '      added workspaceRoot: "~/a"',
    ]);
  });

  it("notes that a write-back change applies from the next pi", () => {
    const plan = planOf({ changes: [{ key: "writeBack.enabled", kind: "add", after: false }] });

    expect(applyLines(plan, FACTS, { existed: false, indent: "\t" }, 76, false).slice(0, 2)).toEqual([
      "When you apply:",
      "  • create ~/.pi/agent/pinata/config.json (applies from the next pi)",
    ]);
  });

  it("words every VM action", () => {
    const actions: VmAction[] = [
      { kind: "restart", size: AUTOMATIC_SIZE, shares: [], parts: ["size", "folders"] },
      { kind: "defer", sessions: 2, parts: ["folders"] },
      { kind: "defer", sessions: 1, parts: ["size"] },
      { kind: "create", size: AUTOMATIC_SIZE, shares: [{ location: "/Users/me", writable: true }] },
      { kind: "on-next-start", parts: ["size"] },
      { kind: "unknown", reason: "colima status failed" },
      { kind: "none" },
    ];

    expect(actions.map((action) => vmActionText(action))).toEqual([
      "restart the sandbox VM with the new size and folders; no pi session is running, and this usually takes under a minute",
      "keep the sandbox VM as it is for now: 2 pi sessions are running. The first pi you start after they all exit restarts it with the new folders",
      "keep the sandbox VM as it is for now: 1 pi session is running. The first pi you start after it exits restarts it with the new size",
      "create the sandbox VM with this folder, pi's sessions folder and pinata's read-only state/vm folder; this takes a minute or two, longer the first time while colima downloads the VM's system image",
      "the sandbox VM is stopped; the next pi starts it with the new size",
      "the sandbox VM could not be checked (colima status failed); run pinata doctor after applying",
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

  it("shows the size a smaller VM keeps under automatic, not this Mac's automatic size", () => {
    const small = { ...FACTS, vm: runningVm({ cpus: 2, memoryGiB: 4, diskGiB: 60 }) };

    expect(automaticLabel(small)).toBe("2 CPUs · 4 GiB memory · 60 GiB disk");
    expect(vmCollapsed("automatic", small, false)).toBe("Automatic: 2 CPUs · 4 GiB memory · 60 GiB disk");
    expect(vmCollapsed("automatic", small, true)).toBe("Automatic (2 CPUs · 4 GiB memory · 60 GiB disk)");
  });

  it("words the chosen size with one colon in plain mode", () => {
    expect(vmCollapsed("automatic", FACTS, false)).toBe("Automatic: 8 CPUs · 10 GiB memory · 60 GiB disk");
    expect(vmCollapsed("automatic", FACTS, true)).toBe("Automatic (8 CPUs · 10 GiB memory · 60 GiB disk)");
    expect(vmCollapsed("automatic", { ...FACTS, vm: RUNNING }, true)).toBe(
      "Automatic (8 CPUs · 10 GiB memory · 100 GiB disk; the VM's disk only grows)",
    );
    expect(vmCollapsed({ cpus: 6, memoryGiB: 30, diskGiB: 60 }, FACTS, true)).toBe(
      "Custom (6 CPUs · 30 GiB memory · 60 GiB disk)",
    );
  });

  it("bounds and words the number fields", () => {
    const facts = { ...FACTS, vm: RUNNING };
    const fields = numberFields(facts, vmBounds(facts));

    expect(fields.cpus).toMatchObject({
      note: "this Mac has 12",
      tooLow: "Choose 1 to 12 CPUs: this Mac has 12.",
    });
    expect(fields.memoryGiB.tooLow).toBe("Choose 2 to 30 GiB: this Mac has 32 GiB and macOS needs the rest.");
    expect(fields.memoryGiB.warn(25)).toBe(
      "That leaves little memory for macOS. Press enter again to keep it.",
    );
    expect(fields.memoryGiB.warn(24)).toBeUndefined();
    expect(fields.diskGiB).toMatchObject({
      note: "412 GiB free on this Mac",
      hint: "the disk can only grow, it is 100 GiB now",
      tooLow: "The VM's disk is 100 GiB now and can only grow. Choose 100 or more.",
      tooHigh: "Choose at most 2048 GiB.",
    });
    expect(fields.diskGiB.warn(600)).toBe(
      "This Mac has 412 GiB free. The disk file grows only as the VM fills it. Press enter again to keep it.",
    );
  });
});

describe("the VM step", () => {
  const create: RunningVm = { kind: "create", size: AUTOMATIC_SIZE, shares: [] };
  const restart: RunningVm = {
    kind: "restart",
    size: AUTOMATIC_SIZE,
    shares: [],
    parts: ["folders"],
  };

  it("words each result", () => {
    const done = (applied: VmApplied, action: RunningVm, elapsed: string, plain: boolean) =>
      eventLines({ kind: "vm-done", applied, action, elapsed }, FACTS, plain);

    expect(done("created", create, "54s", false)).toEqual([
      "✔ Created in 54s: 8 CPUs · 10 GiB memory · 60 GiB disk",
    ]);
    expect(done("restarted", restart, "31s", true)).toEqual(["Restarted the VM in 31s with the new folders"]);
    expect(done("unchanged", restart, "1s", false)).toEqual(["✔ Nothing to do: the VM already matches"]);
    expect(done({ deferred: 1 }, restart, "1s", false)[0]).toMatch(/a pi session started meanwhile/);
  });

  it("names the verb and the last line of the error", () => {
    const failure = {
      kind: "vm-failed",
      action: restart,
      elapsed: "1m 05s",
      reason: "colima stop failed\nsome detail",
    } as const;

    expect(eventLines(failure, FACTS, false)).toEqual([
      "✖ Could not restart the VM after 1m 05s.",
      "  some detail",
    ]);
  });
});

describe("the success screen", () => {
  it("falls back to a placeholder project", () => {
    const success = (root: Answers["root"], vmReady: boolean) =>
      eventLines({ kind: "done", root, vmReady }, FACTS, true);

    expect(success("~/Projects", true)[1]).toBe("Next: cd <a project in ~/Projects> && pi");
    expect(success("/Volumes/Code", false).slice(0, 2)).toEqual([
      "Done. Settings saved.",
      "Next: cd <a project in /Volumes/Code> && pi",
    ]);
  });
});

describe("wrapping", () => {
  it("indents the lines of an indented paragraph", () => {
    expect(wrapped([{ text: "one two three", indent: "  " }, ""], 9)).toEqual(["  one two", "  three", ""]);
  });
});
