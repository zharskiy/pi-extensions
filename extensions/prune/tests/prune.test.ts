import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { KeyPress } from "../../../platform/pi-adapter/index.ts";
import {
  char,
  createFakeAgentRuntime,
  createFakeHost,
  type FakeHost,
  key,
  pause,
  plainTheme,
  startExtension,
} from "../../../test/framework/index.ts";
import { pruneExtension } from "../api/extension.ts";
import { type PruneDeps, prunePlugin } from "../api/plugin.ts";
import { SETTINGS_FILE } from "../core/settings.ts";
import { daysAgo, fabricate, OLD, RECENT, touch } from "./support/session-layout.ts";

type Layout = ReturnType<typeof fabricate>;

const ENTER: KeyPress = key("enter");

const ESCAPE: KeyPress = key("escape");

const DOWN: KeyPress = key("down");

const liveDir = (layout: Layout) => join(layout.agentDir, "pi-prune", "live");

const markerFile = (layout: Layout, id: string) => join(liveDir(layout), `${id}.${process.pid}.json`);

const eventually = (check: () => unknown) => vi.waitFor(check, { interval: 2 });

type BootOptions = { days?: number; swept?: boolean; throws?: number; onAlive?: () => void };

const deps = (layout: Layout, options: BootOptions = {}) => {
  const alive: number[] = [];

  const isAlive = (pid: number) => {
    alive.push(pid);
    options.onAlive?.();

    if (alive.length === options.throws) {
      throw new Error("no process table");
    }

    return pid === process.pid;
  };

  const record: PruneDeps = {
    handoffRoot: layout.handoffRoot,
    isAlive,
    process: { swept: options.swept ?? false },
  };

  return { alive, record };
};

const boot = (layout: Layout, options: BootOptions = {}) => {
  const { alive, record } = deps(layout, options);
  const days = options.days ?? 60;

  mkdirSync(layout.agentDir, { recursive: true });
  writeFileSync(join(layout.agentDir, SETTINGS_FILE), JSON.stringify({ days }));

  const start = (host: FakeHost = layout.host) =>
    startExtension({
      plugins: [prunePlugin(record)],
      settings: { days },
      root: layout.root,
      runtime: createFakeAgentRuntime(),
      host,
    });

  return { alive, process: record.process, start, ...start() };
};

const bootWithSettings = (layout: Layout, user?: unknown, project?: unknown) => {
  const cwd = join(layout.root, "project");
  const host = createFakeHost({ agentDir: layout.agentDir, cwd, projectTrusted: true });
  const extension = pruneExtension(deps(layout).record);

  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(layout.agentDir, { recursive: true });

  if (user !== undefined) {
    writeFileSync(join(layout.agentDir, SETTINGS_FILE), JSON.stringify(user));
  }

  if (project !== undefined) {
    writeFileSync(join(cwd, ".pi", SETTINGS_FILE), JSON.stringify(project));
  }

  extension.boot(host, createFakeAgentRuntime(), { root: extension.options.root, agentDir: layout.agentDir });
  host.start();

  return host;
};

describe("prune sweep on session start", () => {
  it("sweeps with the configured days, sparing the current and parent session", async () => {
    const layout = fabricate();

    layout.run("ninety", "scout-1", daysAgo(90));
    layout.run("ancient", "scout-1", daysAgo(200));
    layout.run("current", "scout-1", daysAgo(200));
    layout.run("parent", "scout-1", daysAgo(200));
    layout.host.info = {
      ...layout.host.info,
      id: "current",
      file: layout.session("current", daysAgo(200)),
      parentSession: layout.session("parent", daysAgo(200)),
    };

    boot(layout, { days: 100 });

    await eventually(() =>
      expect(readdirSync(layout.slugDir).sort()).toEqual([
        "current",
        "current.jsonl",
        "ninety",
        "parent",
        "parent.jsonl",
      ]),
    );
  });

  it("writes the marker before it sweeps", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const booted = boot(layout);

    await eventually(() => expect(existsSync(old)).toBe(false));

    expect(booted.alive).toContain(process.pid);
    expect(JSON.parse(readFileSync(markerFile(layout, "main-session"), "utf8"))).toEqual({
      id: "main-session",
      pid: process.pid,
      file: null,
      parentSession: null,
    });
  });

  it("sweeps once per process, not on later session starts", async () => {
    const layout = fabricate();
    const first = layout.session("first", OLD);
    const booted = boot(layout);

    await eventually(() => expect(existsSync(first)).toBe(false));

    const second = layout.session("second", OLD);

    booted.host.start({ id: "next" });
    booted.start(createFakeHost({ agentDir: layout.agentDir }));
    await pause(50);

    expect(existsSync(second)).toBe(true);
  });

  it("keeps everything when days is 0", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const run = layout.run("old", "scout-1", OLD);
    const empty = layout.empty("empty");
    const booted = boot(layout, { days: 0 });

    await pause(50);

    expect([old, run, empty].map(existsSync)).toEqual([true, true, true]);
    expect(booted.process.swept).toBe(true);
  });

  it.each([
    [
      "the live markers folder is a symbolic link",
      (layout: Layout) => {
        const elsewhere = join(layout.root, "elsewhere");

        mkdirSync(elsewhere);
        mkdirSync(join(layout.agentDir, "pi-prune"), { recursive: true });
        symlinkSync(elsewhere, liveDir(layout));

        return elsewhere;
      },
    ],
    [
      "the live markers folder cannot be created",
      (layout: Layout) => {
        const elsewhere = join(layout.root, "elsewhere");

        mkdirSync(elsewhere);
        writeFileSync(join(layout.agentDir, "pi-prune"), "");

        return elsewhere;
      },
    ],
  ])("writes no marker and does not sweep when %s", async (_case, arrange) => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const elsewhere = arrange(layout);
    const { host } = boot(layout);

    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: `pi-prune: nothing removed, ${liveDir(layout)}: cannot write the liveness marker`,
        level: "warning",
      },
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("warns once when the sweep aborts", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const locked = layout.session("locked", OLD);
    const empty = layout.empty("empty");

    chmodSync(locked, 0o000);

    const booted = boot(layout);

    await eventually(() => expect(booted.host.notices).toHaveLength(1));

    booted.host.start({ id: "next" });
    await pause(50);
    chmodSync(locked, 0o644);

    expect([old, empty].map(existsSync)).toEqual([true, true]);
    expect(booted.host.notices).toEqual([
      { message: `pi-prune: nothing removed, ${locked}: EACCES`, level: "warning" },
    ]);
  });

  it("warns when the sweep throws", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const { host } = boot(layout, { throws: 1 });

    await eventually(() =>
      expect(host.notices).toEqual([
        { message: "pi-prune: sweep failed, no process table", level: "warning" },
      ]),
    );

    expect(existsSync(old)).toBe(true);
  });

  it("tells what it removed in one line, empty handoff folders included", async () => {
    const layout = fabricate();
    const empty = layout.empty("empty");

    layout.session("old", OLD);
    layout.run("old", "scout-1", OLD);
    layout.run("old", "scout-2", OLD);

    const { host } = boot(layout);

    await eventually(() =>
      expect(host.notices).toEqual([
        {
          message: expect.stringMatching(
            /^pi-prune: removed 1 session, 2 agent runs older than 60 days, 1 empty handoff dir, \d+ B freed$/,
          ),
          level: "info",
        },
      ]),
    );
    expect(existsSync(empty)).toBe(false);
  });

  it("says nothing when it removed nothing", async () => {
    const layout = fabricate();

    layout.session("fresh", RECENT);

    const booted = boot(layout);

    await eventually(() => expect(booted.alive).toContain(process.pid));
    await pause(50);

    expect(booted.host.notices).toEqual([]);
  });

  it("scans only the sessions root, whatever folder the session file is in", async () => {
    const layout = fabricate();
    const custom = join(layout.root, "custom");
    const inRoot = layout.session("in-root", OLD);
    const outside = layout.sessionIn(custom, "outside", OLD);

    layout.host.info = { ...layout.host.info, file: layout.sessionIn(custom, "current", RECENT) };

    boot(layout);

    await eventually(() => expect(existsSync(inRoot)).toBe(false));

    expect(existsSync(outside)).toBe(true);
  });
});

describe("liveness marker", () => {
  it("removes its own marker on quit and leaves other processes' markers", async () => {
    const layout = fabricate();
    const other = layout.marker("main-session", process.pid + 1);
    const { host } = boot(layout, { days: 0 });

    expect(existsSync(markerFile(layout, "main-session"))).toBe(true);

    await host.shutdown("quit");

    expect(readdirSync(liveDir(layout))).toEqual([basename(other)]);
  });

  it("keeps the marker over a resume shutdown and replaces it on the next start", async () => {
    const layout = fabricate();
    const { host } = boot(layout, { days: 0 });

    await host.shutdown("resume");

    expect(existsSync(markerFile(layout, "main-session"))).toBe(true);

    host.start({ id: "next", file: "/sessions/next.jsonl" });

    expect(readdirSync(liveDir(layout))).toEqual([`next.${process.pid}.json`]);
    expect(JSON.parse(readFileSync(markerFile(layout, "next"), "utf8")).file).toBe("/sessions/next.jsonl");
  });
});

const formCount = (host: FakeHost, count: number) =>
  eventually(() => {
    expect(host.forms).toHaveLength(count);
  });

const line = (lines: readonly string[], text: string) => lines.find((entry) => entry.includes(text)) ?? "";

const ages = (layout: Layout) => [10, 45, 200].map((days) => layout.session(`aged-${days}`, daysAgo(days)));

const settingsFile = (layout: Layout) => join(layout.agentDir, SETTINGS_FILE);

const menuRows = async (host: FakeHost, count = 1) => {
  await formCount(host, count);

  return host.form().render(120);
};

const pickRow = async (host: FakeHost, count: number, ...keys: KeyPress[]) => {
  await formCount(host, count);
  host.form().press(...keys);
};

const backOut = async (host: FakeHost, count: number) => {
  await pickRow(host, count, ESCAPE);
  await pickRow(host, count + 1, ESCAPE);
};

describe("/prune menu", () => {
  it("opens a menu with Prune now and Auto-prune, whatever was typed after the command", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune", "30 apply");
    const rows = await menuRows(host);

    expect(rows.join("\n")).toContain("Prune sessions");
    expect(line(rows, "1. Prune now")).toMatch(/remove old sessions, up to \d+ B$/);
    expect(line(rows, "2. Auto-prune")).toMatch(/60 days$/);

    host.form().press(ESCAPE);
    await running;

    expect(files.map(existsSync)).toEqual([true, true, true]);
    expect(host.notices).toEqual([]);
    expect(host.confirmations).toEqual([]);
  });

  it("with nothing old enough, Prune now says so and opens no list", async () => {
    const layout = fabricate();

    layout.session("fresh", RECENT);

    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    expect(line(await menuRows(host), "1. Prune now")).toMatch(/nothing to remove$/);

    host.form().press(ENTER);
    await running;

    expect(host.forms).toHaveLength(1);
    expect(host.notices).toEqual([{ message: "pi-prune: nothing to remove at any interval", level: "info" }]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "after a scan abort the menu still opens, names it in Prune now and warns once",
    async () => {
      const layout = fabricate();
      const locked = layout.session("locked", OLD);
      const { host } = boot(layout, { swept: true });

      chmodSync(locked, 0o000);

      const running = host.runCommand("prune");
      const rows = await menuRows(host);

      chmodSync(locked, 0o644);

      expect(line(rows, "1. Prune now")).toMatch(/cannot scan, see the warning$/);

      host.form().press(ENTER);
      await running;

      expect(host.forms).toHaveLength(1);
      expect(host.notices).toEqual([
        { message: `pi-prune: nothing removed, ${locked}: EACCES`, level: "warning" },
      ]);
    },
  );

  it("Escape in a list goes back to the menu without a new scan, Escape in the menu closes", async () => {
    const layout = fabricate();

    ages(layout);

    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    await pickRow(host, 1, ENTER);
    layout.session("later", OLD);
    await pickRow(host, 2, ESCAPE);
    await pickRow(host, 3, DOWN, ENTER);

    expect(line(await menuRows(host, 4), "1. 7 days")).toMatch(/at next start: 3 sessions, \d+ B$/);

    await backOut(host, 4);
    await running;

    expect(host.notices).toEqual([]);
  });

  it("a second /prune while one is open says it is already open", async () => {
    const layout = fabricate();
    const { host } = boot(layout, { swept: true });
    const first = host.runCommand("prune");

    await formCount(host, 1);
    await host.runCommand("prune");

    expect(host.notices).toEqual([{ message: "pi-prune: /prune is already open", level: "info" }]);

    host.form().press(ESCAPE);
    await first;
  });

  it.each(["rpc", "print"] as const)("in %s mode notifies once and touches no file", async (mode) => {
    const layout = fabricate();
    const files = ages(layout);

    layout.host.info = { ...layout.host.info, mode };

    const { host } = boot(layout, { swept: true });

    await host.runCommand("prune");

    expect(host.notices).toEqual([
      {
        message:
          "pi-prune: /prune needs the interactive terminal; days in pi-prune.json sets automatic pruning",
        level: "info",
      },
    ]);
    expect(host.widgets.size).toBe(0);
    expect(host.forms).toEqual([]);
    expect(files.map(existsSync)).toEqual([true, true, true]);
  });
});

describe("/prune now", () => {
  it("lists each interval with counts and bytes, preselecting the configured one, and goes back to it on no", async () => {
    const layout = fabricate();
    const files = ages(layout);

    chmodSync(layout.handoffRoot, 0o777);

    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    await pickRow(host, 1, ENTER);

    const rows = await menuRows(host, 2);

    expect(rows.join("\n")).toContain("Remove sessions not touched for...");
    expect(line(rows, "1. 7 days")).toMatch(/3 sessions, \d+ B$/);
    expect(line(rows, "2. 30 days")).toMatch(/2 sessions, \d+ B$/);
    expect(line(rows, "3. 60 days")).toMatch(/1 session, \d+ B$/);
    expect(line(rows, "6. 365 days")).toMatch(/nothing to remove$/);
    expect(rows.join("\n")).not.toContain("✓");

    host.confirmAnswer = false;
    host.form().press(ENTER);

    expect((await menuRows(host, 3)).join("\n")).toContain("Remove sessions not touched for...");

    await backOut(host, 3);
    await running;

    expect(host.confirmations).toHaveLength(1);
    expect(host.confirmations[0]?.message).toMatch(/^Remove 1 session \(\d+ B\) not touched for 60 days\? /);
    expect(host.confirmations[0]?.message).toContain(
      `Handoff dirs are skipped: ${layout.handoffRoot} is open to other users.`,
    );
    expect(files.map(existsSync)).toEqual([true, true, true]);
    expect(host.notices).toEqual([]);
  });

  it("removes the picked interval after yes, leaving empty handoff folders, and tells the counts and bytes freed", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const empty = layout.empty("empty");

    layout.run("aged-45", "scout-1", daysAgo(45));

    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    await pickRow(host, 1, ENTER);
    await pickRow(host, 2, { name: "up" }, ENTER);
    await running;

    expect(host.confirmations).toEqual([
      {
        title: "Prune sessions?",
        message: expect.stringMatching(
          /^Remove 2 sessions, 1 agent run \(\d+ B\) not touched for 30 days\? A session open in a pi without this extension may still be removed if it is old\. This cannot be undone\.$/,
        ),
      },
    ]);
    expect([...files, empty].map(existsSync)).toEqual([true, false, false, true]);
    expect(host.notices).toEqual([
      {
        message: expect.stringMatching(
          /^pi-prune: removed 2 sessions, 1 agent run older than 30 days, \d+ B freed$/,
        ),
        level: "info",
      },
    ]);
  });

  it("keeps the list open, asking and saying nothing, when the picked interval has nothing to remove", async () => {
    const layout = fabricate();

    ages(layout);

    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    await pickRow(host, 1, ENTER);
    await pickRow(host, 2, DOWN, DOWN, DOWN, ENTER);

    expect((await menuRows(host, 3)).join("\n")).toContain("Remove sessions not touched for...");

    await backOut(host, 3);
    await running;

    expect(host.confirmations).toEqual([]);
    expect(host.notices).toEqual([]);
  });

  it("plans again after the confirm and removes only what was confirmed", async () => {
    const layout = fabricate();
    const written = layout.session("written", OLD);
    const closed = layout.session("closed", OLD);
    const gone = layout.session("gone", OLD);
    const marker = layout.marker("closed", process.pid);
    const { host } = boot(layout, { swept: true });

    host.confirmAnswer = () => {
      touch(written, RECENT);
      rmSync(marker);

      return true;
    };

    const running = host.runCommand("prune");

    await pickRow(host, 1, ENTER);
    await pickRow(host, 2, ENTER);
    await running;

    expect([written, closed, gone].map(existsSync)).toEqual([true, true, false]);
    expect(host.notices.at(-1)?.message).toMatch(
      /^pi-prune: removed 1 session older than 60 days, \d+ B freed, the rest changed since the scan and was kept$/,
    );
  });

  it("says nothing was removed when every confirmed session changed after the confirm", async () => {
    const layout = fabricate();
    const files = [layout.session("first", OLD), layout.session("second", OLD)];
    const { host } = boot(layout, { swept: true });

    host.confirmAnswer = () => {
      files.forEach((file) => {
        touch(file, RECENT);
      });

      return true;
    };

    const running = host.runCommand("prune");

    await pickRow(host, 1, ENTER);
    await pickRow(host, 2, ENTER);
    await running;

    expect(files.map(existsSync)).toEqual([true, true]);
    expect(host.notices).toEqual([
      { message: "pi-prune: nothing removed, the sessions changed since the scan", level: "info" },
    ]);
  });
});

const rendered = (render: unknown) =>
  (render as (width: number, theme: typeof plainTheme) => string[])(80, plainTheme);

describe("/prune progress", () => {
  it("shows Scanning while it scans and Removing after the confirm, and neither in the menu or the confirm", async () => {
    const layout = fabricate();
    const shown: string[] = [];
    const confirming: string[] = [];

    layout.session("old", OLD);

    const { host } = boot(layout, {
      swept: true,
      onAlive: () => {
        shown.push(rendered(layout.host.widgets.get("pi-prune")).join("\n"));
      },
    });

    host.confirmAnswer = () => {
      confirming.push(...host.aboveEditor);

      return true;
    };

    const running = host.runCommand("prune");

    expect(host.aboveEditor).toEqual(["pi-prune"]);

    await formCount(host, 1);

    expect(host.aboveEditor).toEqual([]);

    host.form().press(ENTER);
    await pickRow(host, 2, ENTER);
    await running;

    expect([...new Set(shown)]).toEqual([" ◌ Scanning sessions...", " ◌ Removing old sessions..."]);
    expect(confirming).toEqual([]);
    expect(host.aboveEditor).toEqual([]);
    expect(host.notices).toHaveLength(1);
  });

  it.each([
    ["the scan", 1, 0],
    ["the scan after the confirm", 2, 2],
  ])("clears the line and warns when %s throws", async (_when, throws, forms) => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const { host } = boot(layout, { swept: true, throws });
    const running = host.runCommand("prune");

    if (forms > 0) {
      await pickRow(host, 1, ENTER);
      await pickRow(host, 2, ENTER);
    }

    await running;

    expect(host.forms).toHaveLength(forms);
    expect(host.aboveEditor).toEqual([]);
    expect(host.notices).toEqual([{ message: "pi-prune: prune failed, no process table", level: "warning" }]);
    expect(existsSync(old)).toBe(true);
  });
});

describe("/prune auto-prune", () => {
  it("marks and preselects the configured interval, telling what the next start removes", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    await pickRow(host, 1, DOWN, ENTER);

    const rows = await menuRows(host, 2);

    expect(rows.join("\n")).toContain("Auto-prune sessions not touched for...");
    expect(line(rows, "1. 7 days")).toMatch(/at next start: 3 sessions, \d+ B$/);
    expect(line(rows, "3. 60 days ✓")).toMatch(/at next start: 1 session, \d+ B$/);
    expect(line(rows, "6. 365 days")).toMatch(/365 days$/);
    expect(line(rows, "7. Off")).toMatch(/Off$/);

    host.form().press(ENTER);
    await running;

    expect(readFileSync(settingsFile(layout), "utf8")).toBe('{\n  "days": 60\n}\n');
    expect(files.map(existsSync)).toEqual([true, true, true]);
  });

  it.each([
    [0, "7. Off ✓"],
    [45, undefined],
  ])("with days %s marks %s", async (days, marked) => {
    const layout = fabricate();
    const { host } = boot(layout, { swept: true, days });
    const running = host.runCommand("prune");

    await pickRow(host, 1, DOWN, ENTER);

    const rows = await menuRows(host, 2);

    expect(rows.filter((row) => row.includes("✓"))).toEqual(marked ? [line(rows, marked)] : []);

    host.form().press(ESCAPE);
    await pickRow(host, 3, ESCAPE);
    await running;
  });

  it.each([
    ["90 days", [DOWN, ENTER], 90, "sessions not touched for 90 days are now removed when pi starts"],
    ["Off", [char("7")], 0, "automatic pruning is off"],
  ])("choosing %s writes the file, removes nothing and says so", async (_label, keys, days, text) => {
    const layout = fabricate();
    const files = ages(layout);
    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    await pickRow(host, 1, DOWN, ENTER);
    await pickRow(host, 2, ...keys);
    await running;

    expect(readFileSync(settingsFile(layout), "utf8")).toBe(`{\n  "days": ${days}\n}\n`);
    expect(files.map(existsSync)).toEqual([true, true, true]);
    expect(host.confirmations).toEqual([]);
    expect(host.notices).toEqual([{ message: `pi-prune: ${text}`, level: "info" }]);
  });

  it("the next process sweeps at the chosen days", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("prune");

    await pickRow(host, 1, DOWN, ENTER);
    await pickRow(host, 2, { name: "up" }, ENTER);
    await running;
    await host.shutdown("quit");

    bootWithSettings(layout);

    await eventually(() => expect(files.map(existsSync)).toEqual([true, false, false]));
  });

  it("choosing an interval repairs a broken file", async () => {
    const layout = fabricate();
    const host = bootWithSettings(layout, { days: -1 });
    const first = host.runCommand("prune");

    expect(line(await menuRows(host), "2. Auto-prune")).toMatch(/off, pi-prune.json has an error$/);

    host.form().press(DOWN, ENTER);
    await pickRow(host, 2, { name: "up" }, { name: "up" }, ENTER);
    await first;

    expect(host.notices.at(-1)).toEqual({
      message: "pi-prune: sessions not touched for 60 days are now removed when pi starts",
      level: "info",
    });

    const second = host.runCommand("prune");

    expect(line(await menuRows(host, 3), "2. Auto-prune")).toMatch(/60 days$/);

    host.form().press(ESCAPE);
    await second;
  });

  it("a trusted project file error survives the save and is reported", async () => {
    const layout = fabricate();
    const host = bootWithSettings(layout, { days: 60 }, { days: 1 });
    const project = join(layout.root, "project", ".pi", SETTINGS_FILE);
    const running = host.runCommand("prune");

    await pickRow(host, 1, DOWN, ENTER);
    await pickRow(host, 2, ENTER);
    await running;

    expect(host.notices.at(-1)).toEqual({
      message: `pi-prune: saved, but automatic pruning stays off until pi-prune.json loads without errors:\n  ${project}: ignored, pi-prune.json is read only from ${settingsFile(layout)}`,
      level: "warning",
    });
  });

  it("a failed write warns and changes nothing", async () => {
    const layout = fabricate();
    const { host } = boot(layout, { swept: true });

    rmSync(settingsFile(layout));
    mkdirSync(settingsFile(layout));

    const running = host.runCommand("prune");

    await pickRow(host, 1, DOWN, ENTER);
    await pickRow(host, 2, ENTER);
    await running;

    expect(host.notices).toEqual([
      {
        message: expect.stringMatching(new RegExp(`^pi-prune: cannot save ${settingsFile(layout)}: `)),
        level: "warning",
      },
    ]);
    expect(readdirSync(settingsFile(layout))).toEqual([]);
  });
});

describe("/prune stays out of the session", () => {
  it("a prune and an auto-prune choice add nothing the model can see", async () => {
    const layout = fabricate();

    layout.session("old", OLD);

    const { host } = boot(layout, { swept: true });
    const pruning = host.runCommand("prune");

    await pickRow(host, 1, ENTER);
    await pickRow(host, 2, ENTER);
    await pruning;

    const choosing = host.runCommand("prune");

    await pickRow(host, 3, DOWN, ENTER);
    await pickRow(host, 4, ENTER);
    await choosing;

    expect(host.notices).toHaveLength(2);
    expect([...host.tools.keys()]).toEqual([]);
    expect([...host.promptSections.keys()]).toEqual([]);
    expect(host.mainPrompt).toBeUndefined();
    expect([
      host.entries,
      host.chat,
      host.hidden,
      host.messages,
      host.dispatched,
      host.editorSubmissions,
    ]).toEqual([[], [], [], [], [], []]);
  });
});

describe("prune settings", () => {
  it("rejects days in a trusted project file and does not sweep", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const host = bootWithSettings(layout, { days: 60 }, { days: 1 });
    const project = join(layout.root, "project", ".pi", SETTINGS_FILE);

    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(host.notices.map((notice) => notice.message)).toEqual([
      `pi-prune settings: ${project}: ignored, ${SETTINGS_FILE} is read only from ${settingsFile(layout)}`,
    ]);
  });

  it("keeps 180 days when no settings file sets days", async () => {
    const layout = fabricate();
    const host = bootWithSettings(layout, {});
    const running = host.runCommand("prune");

    expect(line(await menuRows(host), "2. Auto-prune")).toMatch(/180 days$/);

    host.form().press(ESCAPE);
    await running;
  });

  it.each([1.5, -1])("does not sweep with days %s", async (days) => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const empty = layout.empty("empty");
    const host = bootWithSettings(layout, { days });

    await pause(50);

    expect([old, empty].map(existsSync)).toEqual([true, true]);
    expect(host.notices.at(0)?.message).toContain("days must be a whole number between 0 and 36500");
  });
});
