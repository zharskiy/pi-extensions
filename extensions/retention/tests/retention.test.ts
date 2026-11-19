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
  createFakeAgentRuntime,
  createFakeHost,
  type FakeHost,
  key,
  pause,
  startExtension,
} from "../../../test/framework/index.ts";
import { retentionExtension } from "../api/extension.ts";
import { type RetentionDeps, retentionPlugin } from "../api/plugin.ts";
import { SETTINGS_FILE } from "../core/settings.ts";
import { daysAgo, fabricate, OLD, RECENT, touch } from "./support/session-layout.ts";

type Layout = ReturnType<typeof fabricate>;

const ENTER: KeyPress = key("enter");

const ESCAPE: KeyPress = key("escape");

const DOWN: KeyPress = key("down");

const USAGE = "pi-retention: usage /retention [<days>] [apply], <days> a whole number from 7 to 36500";

const liveDir = (layout: Layout) => join(layout.agentDir, "pi-retention", "live");

const markerFile = (layout: Layout, id: string) => join(liveDir(layout), `${id}.${process.pid}.json`);

const deps = (layout: Layout, swept = false, throws = false) => {
  const alive: number[] = [];

  const isAlive = (pid: number) => {
    alive.push(pid);

    if (throws) {
      throw new Error("no process table");
    }

    return pid === process.pid;
  };

  const record: RetentionDeps = { handoffRoot: layout.handoffRoot, isAlive, process: { swept } };

  return { alive, record };
};

type BootOptions = { retentionDays?: number; swept?: boolean; throws?: boolean };

const boot = (layout: Layout, options: BootOptions = {}) => {
  const { alive, record } = deps(layout, options.swept, options.throws);

  const start = (host: FakeHost = layout.host) =>
    startExtension({
      plugins: [retentionPlugin(record)],
      settings: { retentionDays: options.retentionDays ?? 60 },
      root: layout.root,
      runtime: createFakeAgentRuntime(),
      host,
    });

  return { alive, process: record.process, start, ...start() };
};

const bootWithSettings = (layout: Layout, user: unknown, project?: unknown) => {
  const cwd = join(layout.root, "project");
  const host = createFakeHost({ agentDir: layout.agentDir, cwd, projectTrusted: true });
  const extension = retentionExtension(deps(layout).record);

  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(layout.agentDir, { recursive: true });
  writeFileSync(join(layout.agentDir, SETTINGS_FILE), typeof user === "string" ? user : JSON.stringify(user));

  if (project !== undefined) {
    writeFileSync(join(cwd, ".pi", SETTINGS_FILE), JSON.stringify(project));
  }

  extension.boot(host, createFakeAgentRuntime(), { root: extension.options.root, agentDir: layout.agentDir });
  host.start();

  return host;
};

describe("retention sweep on session start", () => {
  it("sweeps with the configured retention, sparing the current and parent session", async () => {
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

    boot(layout, { retentionDays: 100 });

    await vi.waitFor(() =>
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

    await vi.waitFor(() => expect(existsSync(old)).toBe(false));

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

    await vi.waitFor(() => expect(existsSync(first)).toBe(false));

    const second = layout.session("second", OLD);

    booted.host.start({ id: "next" });
    booted.start(createFakeHost({ agentDir: layout.agentDir }));
    await pause(50);

    expect(existsSync(second)).toBe(true);
  });

  it("keeps everything when retentionDays is 0", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const run = layout.run("old", "scout-1", OLD);
    const booted = boot(layout, { retentionDays: 0 });

    await pause(50);

    expect([old, run].map(existsSync)).toEqual([true, true]);
    expect(booted.process.swept).toBe(true);
  });

  it("does not sweep when the live markers folder is a symbolic link", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const elsewhere = join(layout.root, "elsewhere");

    mkdirSync(elsewhere);
    mkdirSync(join(layout.agentDir, "pi-retention"), { recursive: true });
    symlinkSync(elsewhere, liveDir(layout));

    const { host } = boot(layout);

    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: `pi-retention: nothing removed, ${liveDir(layout)}: cannot write the liveness marker`,
        level: "warning",
      },
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("warns once when the sweep aborts", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const locked = layout.session("locked", OLD);

    chmodSync(locked, 0o000);

    const booted = boot(layout);

    await vi.waitFor(() => expect(booted.host.notices).toHaveLength(1));

    booted.host.start({ id: "next" });
    await pause(50);
    chmodSync(locked, 0o644);

    expect(existsSync(old)).toBe(true);
    expect(booted.host.notices).toEqual([
      { message: `pi-retention: nothing removed, ${locked}: EACCES`, level: "warning" },
    ]);
  });

  it("warns when the sweep throws", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const { host } = boot(layout, { throws: true });

    await vi.waitFor(() =>
      expect(host.notices).toEqual([
        { message: "pi-retention: sweep failed, no process table", level: "warning" },
      ]),
    );

    expect(existsSync(old)).toBe(true);
  });

  it("tells what it removed in one line", async () => {
    const layout = fabricate();

    layout.session("old", OLD);
    layout.run("old", "scout-1", OLD);
    layout.run("old", "scout-2", OLD);

    const { host } = boot(layout);

    await vi.waitFor(() =>
      expect(host.notices).toEqual([
        { message: "pi-retention: removed 1 session, 2 agent runs older than 60 days", level: "info" },
      ]),
    );
  });

  it("says nothing when it removed nothing", async () => {
    const layout = fabricate();

    layout.session("fresh", RECENT);

    const booted = boot(layout);

    await vi.waitFor(() => expect(booted.alive).toContain(process.pid));
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

    await vi.waitFor(() => expect(existsSync(inRoot)).toBe(false));

    expect(existsSync(outside)).toBe(true);
  });
});

describe("liveness marker", () => {
  it("removes its own marker on quit and leaves other processes' markers", async () => {
    const layout = fabricate();
    const other = layout.marker("main-session", process.pid + 1);
    const { host } = boot(layout, { retentionDays: 0 });

    expect(existsSync(markerFile(layout, "main-session"))).toBe(true);

    await host.shutdown("quit");

    expect(readdirSync(liveDir(layout))).toEqual([basename(other)]);
  });

  it("keeps the marker over a resume shutdown and replaces it on the next start", async () => {
    const layout = fabricate();
    const { host } = boot(layout, { retentionDays: 0 });

    await host.shutdown("resume");

    expect(existsSync(markerFile(layout, "main-session"))).toBe(true);

    host.start({ id: "next", file: "/sessions/next.jsonl" });

    expect(readdirSync(liveDir(layout))).toEqual([`next.${process.pid}.json`]);
    expect(JSON.parse(readFileSync(markerFile(layout, "next"), "utf8")).file).toBe("/sessions/next.jsonl");
  });
});

describe("/retention", () => {
  it("prints the plan without removing anything", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const broken = layout.unreadable("broken", "{nope");

    layout.session("fresh", RECENT);
    layout.run("old", "scout-1", OLD);
    layout.handoff("old", OLD);

    const { host } = boot(layout, { swept: true });

    await host.runCommand("retention", "60");

    const report = host.notices.at(-1)?.message.split("\n") ?? [];

    expect(report[0]).toMatch(/^pi-retention: 60 days, cutoff \d{4}-\d{2}-\d{2}T/);
    expect(report.slice(1)).toEqual([
      "would remove: 1 session, 1 agent run, 1 handoff dir",
      "keeps: 1 session (1 fresh, 0 live, 0 parent)",
      "unreadable, never removed:",
      `  ${broken}`,
    ]);
    expect(existsSync(old)).toBe(true);
  });

  it("notes handoff dirs it skips under an unsafe root", async () => {
    const layout = fabricate();
    const { host } = boot(layout, { swept: true });

    chmodSync(layout.handoffRoot, 0o777);

    await host.runCommand("retention", "60");

    expect(host.notices.at(-1)?.message.split("\n").at(-1)).toBe(
      `handoff dirs skipped: ${layout.handoffRoot} is not a directory of yours closed to others`,
    );
  });

  it.skipIf(process.getuid?.() === 0)("prints why it aborted", async () => {
    const layout = fabricate();
    const locked = layout.session("locked", OLD);
    const { host } = boot(layout, { swept: true });

    chmodSync(locked, 0o000);

    await host.runCommand("retention", "apply");

    expect(host.notices.at(-1)).toEqual({
      message: `pi-retention: nothing removed, ${locked}: EACCES`,
      level: "warning",
    });
  });

  it("removes now with apply and prints the counts", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const { host } = boot(layout, { swept: true });

    await host.runCommand("retention", "apply");

    expect(existsSync(old)).toBe(false);
    expect(host.notices.at(-1)?.message).toBe("pi-retention: removed 1 session older than 60 days");
  });

  it("says it is off when retentionDays is 0", async () => {
    const layout = fabricate();

    layout.host.info = { ...layout.host.info, mode: "rpc" };

    const { host } = boot(layout, { retentionDays: 0 });

    await host.runCommand("retention");

    expect(host.notices.at(-1)?.message).toBe(
      "pi-retention: off, retentionDays is 0; /retention <days> shows what <days> would remove",
    );
  });
});

const formCount = (host: FakeHost, count: number) =>
  vi.waitFor(() => {
    expect(host.forms).toHaveLength(count);
  });

const line = (lines: readonly string[], text: string) => lines.find((entry) => entry.includes(text)) ?? "";

const ages = (layout: Layout) => [10, 45, 200].map((days) => layout.session(`aged-${days}`, daysAgo(days)));

const confirmOf = (count: string, days: number) => ({
  title: "Remove old sessions?",
  message: `Remove ${count} not touched for ${days} days? Sessions open in a pi process without retention are judged by age alone. This cannot be undone.`,
});

describe("/retention picker", () => {
  it("offers each interval with what it would remove, marking and preselecting the configured one", async () => {
    const layout = fabricate();

    ages(layout);

    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("retention");

    await formCount(host, 1);

    const rows = host.form().render(120);

    expect(rows.join("\n")).toContain("Remove sessions not touched for...");
    expect(line(rows, "1. 7 days")).toContain("3 sessions");
    expect(line(rows, "2. 30 days")).toContain("2 sessions");
    expect(line(rows, "3. 60 days ✓")).toContain("1 session");
    expect(line(rows, "6. 365 days")).toContain("nothing to remove");

    host.confirmAnswer = false;
    host.form().press(ENTER);
    await running;

    const offLayout = fabricate();

    ages(offLayout);

    const off = boot(offLayout, { swept: true, retentionDays: 0 }).host;

    off.confirmAnswer = false;

    const offRunning = off.runCommand("retention");

    await formCount(off, 1);

    expect(off.form().render(120).join("\n")).not.toContain("✓");

    off.form().press(ENTER);
    await offRunning;

    expect([...host.confirmations, ...off.confirmations]).toEqual([
      confirmOf("1 session", 60),
      confirmOf("1 session", 180),
    ]);
  });

  it("asks before removing and removes nothing on no", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const { host } = boot(layout, { swept: true });

    host.confirmAnswer = false;

    const running = host.runCommand("retention");

    await formCount(host, 1);
    host.form().press(ENTER);
    await running;

    expect(host.confirmations).toHaveLength(1);
    expect(files.map(existsSync)).toEqual([true, true, true]);
    expect(host.notices).toEqual([]);
  });

  it("removes the picked interval after yes and tells the counts", async () => {
    const layout = fabricate();
    const files = ages(layout);

    layout.run("aged-45", "scout-1", daysAgo(45));

    const { host } = boot(layout, { swept: true });
    const running = host.runCommand("retention");

    await formCount(host, 1);
    host.form().press({ name: "up" }, ENTER);
    await running;

    expect(host.confirmations).toEqual([confirmOf("2 sessions, 1 agent run", 30)]);
    expect(files.map(existsSync)).toEqual([true, false, false]);
    expect(host.notices.at(-1)?.message).toBe(
      "pi-retention: removed 2 sessions, 1 agent run older than 30 days",
    );
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

    const running = host.runCommand("retention");

    await formCount(host, 1);
    host.form().press(ENTER);
    await running;

    expect([written, closed, gone].map(existsSync)).toEqual([true, true, false]);
    expect(host.notices.at(-1)?.message).toBe("pi-retention: removed 1 session older than 60 days");
  });

  it("says nothing on escape and asks nothing when the picked interval has nothing", async () => {
    const layout = fabricate();

    ages(layout);

    const { host } = boot(layout, { swept: true });
    const escaped = host.runCommand("retention");

    await formCount(host, 1);
    host.form().press(ESCAPE);
    await escaped;

    expect(host.notices).toEqual([]);

    const picked = host.runCommand("retention");

    await formCount(host, 2);
    host.form().press(DOWN, DOWN, DOWN, ENTER);
    await picked;

    expect(host.confirmations).toEqual([]);
    expect(host.notices.map((notice) => notice.message)).toEqual([
      "pi-retention: nothing older than 365 days to remove",
    ]);
  });

  it("opens no picker when nothing is old enough for any interval", async () => {
    const layout = fabricate();

    layout.session("fresh", RECENT);

    const { host } = boot(layout, { swept: true });

    await host.runCommand("retention");

    expect(host.forms).toEqual([]);
    expect(host.notices.at(-1)?.message).toBe("pi-retention: nothing to remove at any interval");
  });

  it.skipIf(process.getuid?.() === 0)("reports an aborted scan instead of the picker", async () => {
    const layout = fabricate();
    const locked = layout.session("locked", OLD);
    const { host } = boot(layout, { swept: true });

    chmodSync(locked, 0o000);

    await host.runCommand("retention");

    chmodSync(locked, 0o644);

    expect(host.forms).toEqual([]);
    expect(host.notices).toEqual([
      { message: `pi-retention: nothing removed, ${locked}: EACCES`, level: "warning" },
    ]);
  });

  it("prints the plan at the configured days outside the TUI", async () => {
    const layout = fabricate();

    ages(layout);
    layout.host.info = { ...layout.host.info, mode: "rpc" };

    const { host } = boot(layout, { swept: true });

    await host.runCommand("retention");

    expect(host.notices.at(-1)?.message).toMatch(/^pi-retention: 60 days, cutoff /);
  });
});

describe("/retention args", () => {
  it("prints the plan for /retention 30", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const { host } = boot(layout, { swept: true });

    await host.runCommand("retention", "30");

    const report = host.notices.at(-1)?.message.split("\n") ?? [];

    expect(report[0]).toMatch(/^pi-retention: 30 days, cutoff /);
    expect(report[1]).toBe("would remove: 2 sessions, 0 agent runs, 0 handoff dirs");
    expect(files.map(existsSync)).toEqual([true, true, true]);
  });

  it("removes with /retention 30 apply without asking", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const { host } = boot(layout, { swept: true });

    await host.runCommand("retention", "30 apply");

    expect(host.confirmations).toEqual([]);
    expect(files.map(existsSync)).toEqual([true, false, false]);
    expect(host.notices.at(-1)?.message).toBe("pi-retention: removed 2 sessions older than 30 days");
  });

  it("rejects days below 7 or above 36500, fractions, words and extra words with the usage", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const { host } = boot(layout, { swept: true });
    const inputs = ["0", "6", "07", "1.5", "-3", "36501", "week", "30 30", "apply 30", "apply apply"];

    await inputs.reduce(
      (previous, input) => previous.then(() => host.runCommand("retention", input)),
      Promise.resolve(),
    );

    expect(existsSync(old)).toBe(true);
    expect(host.notices).toEqual(inputs.map(() => ({ message: USAGE, level: "error" })));
  });

  it("completes apply and the intervals, and only apply after the days", () => {
    const layout = fabricate();
    const { host } = boot(layout, { swept: true });
    const complete = (prefix: string) =>
      host.commands
        .get("retention")
        ?.complete?.(prefix)
        ?.map((option) => option.value) ?? null;

    expect(complete("")).toEqual(["7", "30", "60", "90", "180", "365", "apply"]);
    expect(complete("3")).toEqual(["30", "365"]);
    expect(complete("30 ")).toEqual(["30 apply"]);
    expect(complete("apply ")).toBeNull();
    expect(complete("0 ")).toBeNull();
    expect(complete("6 ")).toBeNull();
  });
});

describe("retention settings", () => {
  it("rejects retentionDays in a trusted project file and does not sweep", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const host = bootWithSettings(layout, { retentionDays: 60 }, { retentionDays: 1 });
    const user = join(layout.agentDir, SETTINGS_FILE);
    const project = join(layout.root, "project", ".pi", SETTINGS_FILE);
    const error = `${project}: ignored, ${SETTINGS_FILE} is read only from ${user}`;

    await host.runCommand("retention", "apply");
    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(host.notices.map((notice) => notice.message)).toEqual([
      `pi-retention settings: ${error}`,
      `pi-retention: off until pi-retention.json loads without errors:\n  ${error}`,
    ]);
  });

  it("keeps 180 days when no settings file sets retentionDays", async () => {
    const layout = fabricate();
    const host = bootWithSettings(layout, {});

    await host.runCommand("retention", "apply");

    expect(host.notices.at(-1)?.message).toBe("pi-retention: nothing older than 180 days to remove");
  });

  it("rejects a fractional retentionDays and does not sweep", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const host = bootWithSettings(layout, { retentionDays: 1.5 });

    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(host.notices.at(0)?.message).toContain("retentionDays must be a whole number between 0 and 36500");
  });

  it("removes with explicit days and opens the picker despite a settings error, but not with /retention apply", async () => {
    const layout = fabricate();
    const files = ages(layout);
    const host = bootWithSettings(layout, { retentionDays: 60 }, { retentionDays: 1 });

    await host.runCommand("retention", "apply");

    expect(files.map(existsSync)).toEqual([true, true, true]);

    host.confirmAnswer = false;

    const running = host.runCommand("retention");

    await formCount(host, 1);

    expect(host.form().render(120).join("\n")).not.toContain("✓");

    host.form().press(ENTER);
    await running;
    await host.runCommand("retention", "30 apply");

    expect(host.confirmations).toEqual([confirmOf("1 session", 180)]);
    expect(files.map(existsSync)).toEqual([true, false, false]);
  });

  it("neither sweeps nor applies with an invalid retentionDays", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const host = bootWithSettings(layout, { retentionDays: -1 });

    await host.runCommand("retention", "apply");
    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(host.notices.at(-1)?.message).toMatch(
      /^pi-retention: off until pi-retention.json loads without errors:/,
    );
  });
});
