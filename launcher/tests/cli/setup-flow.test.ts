import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmApplied, VmPhase } from "../../backend/index.ts";
import type { Prompts } from "../../cli/prompt/types.ts";
import { readDocument } from "../../cli/setup/document.ts";
import { runSetup, type SetupInput } from "../../cli/setup/flow.ts";
import type { Answers, FolderCandidate, HostFacts, SetupIo, VmAction } from "../../cli/setup/types.ts";
import { tempDir } from "../support/temp-dir.ts";
import { fakeTimers, KEY, plainPrompts, richPrompts, until } from "./prompt/fake-tty.ts";

const HOME = "/Users/me";

const FILE = `${HOME}/.pi/agent/pi-sandbox/config.json`;

const candidate = (name: string, repos: number, extra: Partial<FolderCandidate> = {}): FolderCandidate => ({
  stored: `~/${name}`,
  resolved: `${HOME}/${name}`,
  exists: true,
  repos,
  capped: false,
  origin: "usual",
  here: false,
  ...extra,
});

const CANDIDATES = [
  candidate("Projects", 14, { latestRepo: `${HOME}/Projects/my-app` }),
  candidate("work", 3, { origin: "cwd", here: true }),
  candidate("src", 0),
];

const FACTS: HostFacts = {
  home: HOME,
  cwd: `${HOME}/work`,
  cpus: 12,
  memoryGiB: 32,
  freeDiskGiB: 412,
  automatic: { cpus: 8, memoryGiB: 10, diskGiB: 60 },
  vm: { state: "absent" },
  sessions: 0,
  candidates: CANDIDATES,
  configFile: FILE,
  docsFile: "/opt/launcher/CONFIGURATION.md",
};

const RUNNING: HostFacts["vm"] = {
  state: "running",
  size: { cpus: 8, memoryGiB: 10, diskGiB: 60 },
  shares: [
    { location: `${HOME}/Projects`, writable: true },
    { location: `${HOME}/work`, writable: true },
  ],
};

const SAVED = `{\n  "workspaceRoots": {\n    "roots": ["~/Projects", "~/work"]\n  }\n}\n`;

const SAVED_STANDARD = `${JSON.stringify({ workspaceRoots: { roots: ["~/Projects", "~/work"] } }, null, 2)}\n`;

const sharesOf = (roots: Answers["roots"]) =>
  roots === "home"
    ? { shares: [{ location: HOME, writable: true }], exact: false }
    : { shares: roots.map((root) => ({ location: root.replace("~", HOME), writable: true })), exact: true };

interface Options {
  text?: string;
  facts?: Partial<HostFacts>;
  plain?: boolean;
  columns?: number;
  rows?: number;
  vm?: Array<VmApplied | Error>;
  write?: () => Promise<void>;
  share?: SetupInput["sharePlan"];
  env?: NodeJS.ProcessEnv;
}

const setup = (options: Options = {}) => {
  const clock = fakeTimers();
  const fake = options.plain
    ? plainPrompts({ timers: clock.timers, columns: options.columns ?? 80 })
    : richPrompts({
        timers: clock.timers,
        columns: options.columns ?? 80,
        rows: options.rows ?? 60,
        env: options.env,
      });
  const writes: string[] = [];
  const vms: VmAction[] = [];
  const phases: VmPhase[] = [];
  const results = [...(options.vm ?? ["created"])];
  const live = { prompts: 0, tasks: 0, exited: false };
  const counted =
    <A extends unknown[], R>(kind: "prompts" | "tasks", ask: (...args: A) => Promise<R>) =>
    (...args: A) => {
      live[kind] += 1;

      return ask(...args).finally(() => {
        live[kind] -= 1;
      });
    };
  const prompts: Prompts = {
    select: counted("prompts", fake.prompts.select),
    multiselect: counted("prompts", fake.prompts.multiselect),
    confirm: counted("prompts", fake.prompts.confirm),
    path: counted("prompts", fake.prompts.path),
    number: counted("prompts", fake.prompts.number),
    task: counted("tasks", fake.prompts.task),
    note: fake.prompts.note,
  };
  const io: SetupIo = {
    prompts,
    plain: options.plain === true,
    now: () => clock.timers.now(),
  };
  const input: SetupInput = {
    read: readDocument(FILE, options.text),
    configFile: FILE,
    home: HOME,
    env: {},
    readdir: () => [],
    detect: async () => ({ ...FACTS, ...options.facts }),
    sharePlan: options.share ?? sharesOf,
  };
  const effects = {
    write: options.write ?? (async (_document: unknown, text: string) => void writes.push(text)),
    vm: async (action: VmAction, progress: (phase: VmPhase) => void) => {
      vms.push(action);

      progress("creating");

      phases.push("creating");

      clock.advance(54_000);

      const result = results.shift() ?? "created";

      if (result instanceof Error) {
        throw result;
      }

      return result;
    },
  };
  const exit = runSetup(io, input, effects).finally(() => {
    live.exited = true;
  });

  const waiting = () => live.exited || (live.prompts > 0 && live.tasks === 0);

  const drained = () => fake.input.readableLength === 0 && fake.input.writableLength === 0;

  const press = async (key: string) => {
    await until(waiting);

    const written = fake.output.text().length;

    fake.input.write(key);

    await until(drained);

    if (key === KEY.escape) {
      await until(() => fake.output.text().length > written);
    }
  };

  const keys = async (...pressed: string[]) => {
    await pressed.reduce((chain, key) => chain.then(() => press(key)), Promise.resolve());

    await until(waiting);
  };

  const settled = () => until(waiting);

  const answer = (...lines: string[]) => keys(...lines.map((line) => `${line}\r`));

  const text = () => fake.screen.lines().join("\n");

  const shown = (wanted: string) => until(() => text().includes(wanted));

  return { ...fake, exit, writes, vms, phases, keys, answer, text, shown, settled };
};

const CURSOR_UP = new RegExp(`${String.fromCharCode(27)}\\[(\\d+)A`, "g");

const STEPS_ACCEPTED = [KEY.enter, KEY.enter, KEY.enter];

describe("a first run", () => {
  it("takes three steps and Apply with Enter only, then creates the VM", async () => {
    const run = setup();

    await run.keys(...STEPS_ACCEPTED, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.writes).toEqual([SAVED_STANDARD]);
    expect(run.vms).toEqual([
      {
        kind: "create",
        size: { cpus: 8, memoryGiB: 10, diskGiB: 60 },
        shares: [
          { location: `${HOME}/Projects`, writable: true },
          { location: `${HOME}/work`, writable: true },
        ],
      },
    ]);

    const lines = run.screen.lines();

    expect(lines.slice(0, 9)).toEqual([
      "┌  pi sandbox setup",
      "│",
      "│  Sets up the sandbox pi runs in, in three short steps: the folders it may",
      "│  use, the size of its VM and the settings write-back. Nothing is saved until",
      "│  you choose Apply.",
      "│",
      "│  This Mac     12 CPUs · 32 GiB memory · 412 GiB free disk",
      "│  Sandbox VM   not created yet",
      "│",
    ]);
    expect(lines).toContain("◇  Project folders");
    expect(lines).toContain("│  ~/Projects, ~/work");
    expect(lines).toContain("│  Automatic: 8 CPUs · 10 GiB memory · 60 GiB disk");
    expect(lines).toContain("◇  Settings write-back");
    expect(lines).toContain("◇  Review");
    expect(lines).toContain("│  ✔ Saved ~/.pi/agent/pi-sandbox/config.json");
    expect(lines).toContain("│  ✔ Created in 54s: 8 CPUs · 10 GiB memory · 60 GiB disk");
    expect(lines.slice(-7)).toEqual([
      "└  Done. The sandbox is ready.",
      "",
      "   Next      cd ~/Projects/my-app && pi",
      "   Change    pi sandbox init",
      "   Check     pi sandbox doctor",
      "   Settings  ~/.pi/agent/pi-sandbox/config.json",
      "             every key: /opt/launcher/CONFIGURATION.md",
    ]);
  });

  it("takes a whole first run typed ahead as one chunk", async () => {
    const run = setup();

    await run.shown("step 1 of 3");

    run.input.write(KEY.enter.repeat(4));

    expect(await run.exit).toBe(0);
    expect(run.writes).toEqual([SAVED_STANDARD]);
  });

  it("takes a whole plain first run typed ahead as one chunk", async () => {
    const run = setup({ plain: true });

    await run.shown("Folders [1 2]:");

    run.input.write("\n\n\n\n");

    expect(await run.exit).toBe(0);
    expect(run.writes).toEqual([SAVED_STANDARD]);
  });

  it("shows the step position in each step's title", async () => {
    const run = setup();

    await run.keys(KEY.enter);

    expect(run.text()).toContain("◆  VM size   step 2 of 3");

    await run.keys(KEY.escape);

    expect(run.screen.lines().filter((line) => line.includes("step 1 of 3")).length).toBeGreaterThan(0);

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
  });

  it("lists the detected folders with aligned repository counts", async () => {
    const run = setup();

    await run.settled();

    const lines = run.screen.lines();

    expect(lines).toContain("◆  Which folders hold your projects?   step 1 of 3");
    expect(lines.some((line) => /■ ~\/Projects\s+14 git repositories$/.test(line))).toBe(true);
    expect(lines.some((line) => /■ ~\/work\s+ {2}3 git repositories · you are here$/.test(line))).toBe(true);

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
  });

  it("applies a customised VM size and write-back off", async () => {
    const run = setup();

    await run.keys(KEY.enter, KEY.down, KEY.enter, "6", KEY.enter, "12", KEY.enter, "80", KEY.enter);

    await run.keys(KEY.right, KEY.enter, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(JSON.parse(run.writes[0] ?? "")).toEqual({
      workspaceRoots: { roots: ["~/Projects", "~/work"] },
      vm: { cpus: 6, memoryGiB: 12, diskGiB: 80 },
      writeBack: { enabled: false },
    });
    expect(run.vms[0]).toMatchObject({ kind: "create", size: { cpus: 6, memoryGiB: 12, diskGiB: 80 } });
    expect(run.screen.lines()).toContain("│  Custom: 6 CPUs · 12 GiB memory · 80 GiB disk");
  });

  it("goes back one field, then to the VM select, from the number fields", async () => {
    const run = setup();

    await run.keys(KEY.enter, KEY.down, KEY.enter, KEY.enter, KEY.escape, KEY.escape, KEY.enter);

    await run.keys(KEY.enter, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.writes).toEqual([SAVED_STANDARD]);
  });

  it("cancels with Esc on the first step and writes nothing", async () => {
    const run = setup();

    await run.keys(KEY.escape);

    expect(await run.exit).toBe(130);
    expect(run.writes).toEqual([]);
    expect(run.screen.lines().at(-1)).toBe("└  Cancelled. Nothing was changed.");
  });

  it("asks before discarding the answers from the hub", async () => {
    const run = setup();

    await run.keys(...STEPS_ACCEPTED, KEY.escape);

    expect(run.text()).toContain("Discard your changes and leave? Nothing has been saved.");

    await run.keys(KEY.enter, KEY.up, KEY.enter);

    await run.keys(KEY.right, KEY.enter);

    expect(await run.exit).toBe(130);
    expect(run.writes).toEqual([]);
  });

  it("asks to share the home when nothing is checked, and goes back on No", async () => {
    const run = setup();

    await run.keys(KEY.space, KEY.down, KEY.space, KEY.enter);

    expect(run.text()).toContain("◆  Share your whole home with the sandbox VM instead?   step 1 of 3");

    await run.keys(KEY.enter, KEY.enter);

    await run.keys(KEY.right, KEY.enter, ...STEPS_ACCEPTED.slice(1), KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.writes).toEqual([]);
    expect(run.screen.lines()).toContain("│  your whole home (~), not recommended");
    expect(run.vms[0]).toMatchObject({ kind: "create", shares: [{ location: HOME, writable: true }] });
  });

  it("treats a file without workspaceRoots as a first run and pre-checks the detected folders", async () => {
    const run = setup({ text: "{}\n" });

    await run.keys(...STEPS_ACCEPTED, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(JSON.parse(run.writes[0] ?? "").workspaceRoots.roots).toEqual(["~/Projects", "~/work"]);
  });

  it("never shares the home of a file without workspaceRoots without the confirm", async () => {
    const run = setup({
      text: '{ "egress": { "allow": [] } }\n',
      facts: { candidates: [candidate("src", 0)] },
    });

    await run.keys(KEY.enter);

    expect(run.text()).toContain("Share your whole home with the sandbox VM instead?");

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
    expect(run.vms).toEqual([]);
  });

  it("says what the VM shares now and starts the confirm on Yes when it shares the home", async () => {
    const vm = { ...RUNNING, shares: [{ location: HOME, writable: true }] } as HostFacts["vm"];
    const run = setup({ text: "{}\n", facts: { vm } });

    await run.shown("The sandbox VM shares your whole home (~) now.");

    await run.keys(KEY.space, KEY.down, KEY.space, KEY.enter, KEY.enter);

    expect(run.text()).toContain("│  your whole home (~), not recommended");
    expect(run.text()).toContain("step 2 of 3");

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
  });

  it("says when looking for folders took too long, unlike when nothing was found", async () => {
    const late = setup({ facts: { candidates: [], searchTimedOut: true } });

    await late.shown("Looking for project folders took too long.");

    expect(late.text()).not.toContain("No usual project folder was found");

    await late.keys(KEY.ctrlC);

    const none = setup({ facts: { candidates: [] } });

    await none.shown("No usual project folder was found in your home.");

    await none.keys(KEY.ctrlC);

    expect([await late.exit, await none.exit]).toEqual([130, 130]);
  });

  it("returns to the list unchanged when the add-folder input is left", async () => {
    const run = setup();

    await run.keys(KEY.end, KEY.enter, KEY.escape, KEY.home, ...STEPS_ACCEPTED, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.writes).toEqual([SAVED_STANDARD]);
    expect(run.text()).not.toContain("◇  Add a folder");
  });

  it("adds a typed folder to the list, checked, and saves it after the others", async () => {
    const home = await realpath(await tempDir("setup-flow-home"));

    await mkdir(join(home, "oss"));

    const run = setup({
      facts: { home, candidates: [candidate("work", 3, { resolved: join(home, "work") })] },
    });

    await run.keys(KEY.down, KEY.enter, "oss", KEY.enter, KEY.home, ...STEPS_ACCEPTED, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(JSON.parse(run.writes[0] ?? "").workspaceRoots.roots).toEqual(["~/work", "~/oss"]);
  });

  it("cancels on ctrl-c at each step without writing", async () => {
    const steps = [[], [KEY.enter], [KEY.enter, KEY.enter], STEPS_ACCEPTED];
    const exits = await Promise.all(
      steps.map(async (before) => {
        const run = setup();

        await run.keys(...before, KEY.ctrlC);

        return { exit: await run.exit, writes: run.writes };
      }),
    );

    expect(exits).toEqual(steps.map(() => ({ exit: 130, writes: [] })));
  });
});

describe("a re-run", () => {
  it("asks the home confirm from the review without a step counter", async () => {
    const run = setup({ text: SAVED, facts: { vm: RUNNING } });

    await run.settled();

    await run.keys(KEY.down, KEY.enter);

    await run.shown("Which folders hold your projects?");

    await run.keys(KEY.space, KEY.down, KEY.space, KEY.enter);

    await run.shown("Share your whole home with the sandbox VM instead?");

    expect(run.screen.lines()).toContain("◆  Share your whole home with the sandbox VM instead?");
    expect(run.text()).not.toContain("step 1 of 3");

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
  });

  it("opens the hub and says when nothing needs to change", async () => {
    const run = setup({ text: SAVED, facts: { vm: RUNNING } });

    await run.settled();

    expect(run.text()).not.toContain("step 1 of 3");
    expect(run.text()).toContain("│  Your settings:");
    expect(run.screen.lines()).toContain(
      "│  Everything is set up: the file and the sandbox VM already match these",
    );

    await run.keys(KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.screen.lines().at(-1)).toBe("└  Nothing changed.");
    expect(run.writes).toEqual([]);
  });

  it("shows the change and restarts the idle VM", async () => {
    const run = setup({ text: SAVED, facts: { vm: RUNNING }, vm: ["restarted"] });

    await run.keys(KEY.down, KEY.down, KEY.enter, KEY.down, KEY.enter);

    await run.keys(KEY.enter, `${KEY.backspace}${KEY.backspace}12`, KEY.enter, KEY.enter);

    const lines = run.screen.lines();

    expect(lines).toContain("│        + vm.cpus        8");
    expect(lines).toContain("│        + vm.memoryGiB   12");
    expect(
      lines.some((line) => line.includes("restart the sandbox VM with the new size; no pi session is")),
    ).toBe(true);

    await run.keys(KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.vms[0]).toMatchObject({ kind: "restart", size: { memoryGiB: 12 }, parts: ["size"] });
    expect(run.screen.lines()).toContain("│  ✔ Restarted in 54s with the new size");
  });

  it("defers the VM while sessions are live and says so", async () => {
    const run = setup({ text: SAVED, facts: { vm: RUNNING, sessions: 2 } });

    await run.keys(KEY.down, KEY.enter, KEY.down, KEY.down, KEY.space, KEY.enter, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.vms).toEqual([]);
    expect(run.writes).toHaveLength(1);
    expect(run.screen.lines()).toContain(
      "│  ▲ Kept as it is: 2 pi sessions are running. The first pi you start after",
    );
    expect(run.screen.lines()).toContain("└  Done. Settings saved.");
  });
});

describe("the VM step", () => {
  it("offers to try again after a failure, then succeeds", async () => {
    const run = setup({ vm: [new Error("colima start failed\nexit status 1"), "created"] });

    await run.keys(...STEPS_ACCEPTED, KEY.enter);

    await run.settled();

    const lines = run.screen.lines();

    expect(lines).toContain("│  ✖ Could not create the VM after 54s.");
    expect(lines).toContain("│    exit status 1");
    expect(lines).toContain("│  ↑↓ move · enter choose · esc/ctrl-c exit");

    await run.keys(KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.vms).toHaveLength(2);
    expect(run.writes).toHaveLength(1);
  });

  it("exits 1 with the settings saved when the user gives up", async () => {
    const run = setup({ vm: [new Error("colima start failed")] });

    await run.keys(...STEPS_ACCEPTED, KEY.enter, KEY.down, KEY.enter);

    expect(await run.exit).toBe(1);
    expect(run.writes).toHaveLength(1);
    expect(run.text()).toContain("└  Your settings are saved, but the sandbox VM is not ready.");
  });

  it("reports a save failure and leaves the VM alone", async () => {
    const run = setup({
      write: async () => {
        throw new Error("could not save x: the file changed while setup ran");
      },
    });

    await run.keys(...STEPS_ACCEPTED, KEY.enter);

    expect(await run.exit).toBe(1);
    expect(run.vms).toEqual([]);
    expect(run.text()).toContain(
      "│  ✖ Could not save ~/.pi/agent/pi-sandbox/config.json: the file changed while",
    );
    expect(run.screen.lines().at(-1)).toBe("└  Nothing was changed.");
  });
});

describe("an invalid config", () => {
  it("stops on a file that is not JSON", async () => {
    const run = setup({ text: "{ nope" });

    expect(await run.exit).toBe(1);
    expect(run.screen.lines().slice(0, 3)).toEqual([
      "┌  pi sandbox setup",
      "│",
      "│  ✖ ~/.pi/agent/pi-sandbox/config.json is not valid JSON:",
    ]);
    expect(run.screen.lines().slice(-2)).toEqual([
      "└  Nothing was changed. Fix the file, or move it away to start over, then run",
      "   pi sandbox init again.",
    ]);
  });

  it("stops on a key this setup does not own", async () => {
    const run = setup({ text: '{ "unknownKey": 1 }' });

    expect(await run.exit).toBe(1);
    expect(run.text()).toContain("has a problem this setup does not fix:");
    expect(run.screen.lines().at(-1)).toBe(
      "└  Nothing was changed. Fix that key, then run pi sandbox init again.",
    );
  });

  it("marks a bad owned key invalid and fixes it on Apply", async () => {
    const run = setup({
      text: '{ "workspaceRoots": { "roots": ["~/Projects"] }, "vm": { "memoryGiB": -1 } }',
    });

    await run.settled();

    expect(run.screen.lines().some((line) => /VM size\s+.*invalid$/.test(line))).toBe(true);

    await run.keys(KEY.enter);

    expect(await run.exit).toBe(0);
    expect(JSON.parse(run.writes[0] ?? "").vm).toBeUndefined();
  });

  it("refuses Apply while the folders nest with a launcher path", async () => {
    const run = setup({
      share: () => ({ problem: "config: workspaceRoots: ~/work holds the sessions dir" }),
    });

    await run.keys(...STEPS_ACCEPTED, KEY.enter);

    expect(run.text()).toContain("✖ Fix the project folders first.");
    expect(run.text()).toContain("config: workspaceRoots: ~/work holds the sessions dir");

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
    expect(run.writes).toEqual([]);
  });
});

describe("the review hub on an 80x24 terminal", () => {
  const MENU = ["Apply", "Change project folders", "Change VM size", "Change settings write-back", "Cancel"];

  const liveHub = async (run: ReturnType<typeof setup>) => {
    await run.shown("◆  Review");

    const lines = run.screen.lines();
    const live = lines.slice(lines.findLastIndex((line) => line.startsWith("◆  Review")));
    const written = run.output.text().length;

    await run.keys(KEY.down);

    const ups = (run.output.text().slice(written).match(CURSOR_UP) ?? []).map((up) =>
      Number(up.slice(2, -1)),
    );

    await run.keys(KEY.ctrlC);

    return { live, ups };
  };

  it("keeps the whole menu of a first run visible in a live frame shorter than the screen", async () => {
    const run = setup({ rows: 24 });

    await run.keys(...STEPS_ACCEPTED);

    const hub = await liveHub(run);

    expect(hub.live.length).toBeLessThanOrEqual(23);
    expect(MENU.every((item) => hub.live.some((line) => line.endsWith(` ${item}`)))).toBe(true);
    expect(Math.max(...hub.ups)).toBeLessThan(23);
    expect(run.text()).not.toContain("│  Your settings:");
    expect(run.text()).toContain("│  When you apply:");
  });

  it("prints a re-run's diff above the menu and keeps the menu whole", async () => {
    const run = setup({
      rows: 24,
      text: '{"workspaceRoots": {"roots": ["~/Projects", "~/.ssh"]}, "vm": {"memoryGiB": -3}}\n',
      facts: { vm: RUNNING },
    });

    const hub = await liveHub(run);

    expect(hub.live.length).toBeLessThanOrEqual(23);
    expect(MENU.every((item) => hub.live.some((line) => line.endsWith(` ${item}`)))).toBe(true);
    expect(hub.live.some((line) => line.includes("vm.memoryGiB"))).toBe(false);
    expect(run.text()).toContain("vm.memoryGiB");
  });

  it("prints the summary again after an edit, right above the menu", async () => {
    const run = setup({ rows: 24 });

    await run.keys(...STEPS_ACCEPTED, KEY.end, KEY.up, KEY.enter, KEY.right, KEY.enter);

    await run.shown("◆  Review");

    const lines = run.screen.lines();
    const summaries = lines.flatMap((line, index) => (line === "│  Your settings:" ? [index] : []));
    const menu = lines.findLastIndex((line) => line.startsWith("◆  Review"));
    const latest = lines.slice(summaries.at(-1), menu);

    expect(summaries).toHaveLength(1);
    expect(latest.some((line) => /Settings write-back\s+off\s+chosen$/.test(line))).toBe(true);

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
  });
});

describe("narrow terminals", () => {
  const PROBLEMS = '{"workspaceRoots": {"roots": ["~/Projects", "~/.ssh"]}, "vm": {"memoryGiB": -3}}\n';

  const framed = (lines: string[]) =>
    lines.slice(
      0,
      lines.findIndex((line) => line.startsWith("└")),
    );

  it.each([40, 60, 80])(
    "wraps every line of a first run at %i columns without cutting it",
    async (columns) => {
      const run = setup({ columns, rows: 24 });

      await run.keys(...STEPS_ACCEPTED, KEY.enter);

      expect(await run.exit).toBe(0);

      const lines = run.screen.lines();

      expect(lines.filter((line) => line.endsWith("…"))).toEqual([]);
      expect(lines.filter((line) => line.length > columns - 1)).toEqual([]);
      expect(framed(lines).filter((line) => !/^[┌│◇◆└]/.test(line))).toEqual([]);
    },
  );

  it.each([40, 60, 80])("wraps the values, problems and diff of the hub at %i columns", async (columns) => {
    const run = setup({ columns, rows: 24, text: PROBLEMS, facts: { vm: RUNNING } });

    await run.shown("◆  Review");

    const lines = run.screen.lines();

    expect(lines.filter((line) => line.endsWith("…"))).toEqual([]);
    expect(lines.filter((line) => line.length > columns - 1)).toEqual([]);
    expect(lines.filter((line) => !/^[┌│◇◆]/.test(line))).toEqual([]);
    expect(run.text()).toContain("config: workspaceRoots.roots:");
    expect(run.text()).toContain("vm.memoryGiB");

    await run.keys(KEY.ctrlC);

    expect(await run.exit).toBe(130);
  });
});

describe("an ASCII terminal", () => {
  it("runs the whole first run without a non-ASCII character", async () => {
    const run = setup({ env: { LANG: "C", LC_ALL: "C" } });

    await run.keys(...STEPS_ACCEPTED, KEY.enter);

    expect(await run.exit).toBe(0);
    expect(run.text()).toContain("Done. The sandbox is ready.");
    expect(/[^\x20-\x7e\n]/.test(run.text())).toBe(false);
  });
});

describe("plain mode", () => {
  it("prints the first-run transcript", async () => {
    const run = setup({ plain: true, columns: 200 });

    await run.answer("", "", "", "");

    expect(await run.exit).toBe(0);
    expect(run.screen.lines()).toEqual([
      "pi sandbox setup",
      "Checking this Mac and the sandbox VM...",
      "This Mac: 12 CPUs, 32 GiB memory, 412 GiB free disk",
      "Sandbox VM: not created yet",
      "Nothing is saved until you choose Apply.",
      "",
      "Which folders hold your projects?   step 1 of 3",
      "Only these folders are shared with the sandbox VM, and pi starts only inside",
      "them.",
      "  1) [x] ~/Projects (14 git repositories)",
      "  2) [x] ~/work (3 git repositories, you are here)",
      "  3) [ ] ~/src (no git repository found)",
      "Type numbers to switch folders on or off (like 1 3), a path to add a folder,",
      "or press Enter to keep the selection.",
      "Folders [1 2]:",
      "Project folders: ~/Projects, ~/work",
      "",
      "VM size   step 2 of 3",
      "Every pi session runs in this VM. Automatic follows this Mac: CPUs from 2 to 8,",
      "half the memory from 4 to 10 GiB, and a 60 GiB disk.",
      "  1) Automatic (8 CPUs, 10 GiB memory, 60 GiB disk)",
      "  2) Custom...",
      "Choose [1]:",
      "VM size: Automatic (8 CPUs, 10 GiB memory, 60 GiB disk)",
      "",
      "When on, preference changes made inside the sandbox (the default model, the",
      "theme, extension settings) are copied to your pi on this Mac when a session",
      "starts and ends. Your pi wins when both changed.",
      "Copy settings changed in the sandbox back to your pi?   step 3 of 3 (Y/n):",
      "Settings write-back: on",
      "",
      "Review",
      "  Project folders: ~/Projects, ~/work (chosen)",
      "  VM size: 8 CPUs, 10 GiB memory, 60 GiB disk (automatic)",
      "  Settings write-back: on (default)",
      "When you apply:",
      "  - create ~/.pi/agent/pi-sandbox/config.json",
      '      added workspaceRoots.roots: ["~/Projects","~/work"]',
      "  - create the sandbox VM with these folders; this takes a minute or two,",
      "    longer the first time while colima downloads the VM's system image",
      "  1) Apply",
      "  2) Change project folders",
      "  3) Change VM size",
      "  4) Change settings write-back",
      "  5) Cancel",
      "Choose [1]:",
      "Saved ~/.pi/agent/pi-sandbox/config.json",
      "Creating the VM...",
      "  still working (15s)",
      "  still working (30s)",
      "  still working (45s)",
      "Created the VM in 54s: 8 CPUs, 10 GiB memory, 60 GiB disk",
      "Done. The sandbox is ready.",
      "Next: cd ~/Projects/my-app && pi",
      "Change: pi sandbox init",
      "Check: pi sandbox doctor",
      "Settings: ~/.pi/agent/pi-sandbox/config.json",
    ]);
  });

  it("adds a typed path to the folders, re-asking the folders after a refused one", async () => {
    const home = await realpath(await tempDir("setup-flow-plain-home"));

    await mkdir(join(home, "oss"));

    const run = setup({
      plain: true,
      facts: { home, candidates: [candidate("work", 3, { resolved: join(home, "work") })] },
    });

    await run.answer("~/missing", "~/oss", "", "", "", "");

    expect(await run.exit).toBe(0);
    expect(JSON.parse(run.writes[0] ?? "").workspaceRoots.roots).toEqual(["~/work", "~/oss"]);

    const lines = run.screen.lines();
    const refused = lines.findIndex((line) => line.startsWith("Folders [1]: ~/missing"));

    expect(lines[refused + 1]).toMatch(/^Error: /);
    expect(lines).toContain("  2) [x] ~/oss");
    expect(lines).toContain("Folders [1 2]:");
    expect(run.text()).not.toContain("Add a folder");
  });
});
