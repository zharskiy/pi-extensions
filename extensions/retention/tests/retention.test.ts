import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createFakeAgentRuntime,
  createFakeHost,
  type FakeHost,
  pause,
  startExtension,
} from "../../../test/framework/index.ts";
import { retentionExtension } from "../api/extension.ts";
import { type RetentionDeps, retentionPlugin } from "../api/plugin.ts";
import { SETTINGS_FILE } from "../core/settings.ts";
import { daysAgo, fabricate, OLD, RECENT } from "./support/session-layout.ts";

type Layout = ReturnType<typeof fabricate>;

const liveDir = (layout: Layout) => join(layout.agentDir, "pi-retention", "live");

const markerFile = (layout: Layout, id: string) => join(liveDir(layout), `${id}.${process.pid}.json`);

const deps = (layout: Layout, swept = false) => {
  const alive: number[] = [];

  const isAlive = (pid: number) => {
    alive.push(pid);

    return pid === process.pid;
  };

  const record: RetentionDeps = { handoffRoot: layout.handoffRoot, isAlive, process: { swept } };

  return { alive, record };
};

const boot = (layout: Layout, options: { retentionDays?: number; swept?: boolean } = {}) => {
  const { alive, record } = deps(layout, options.swept);

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

    boot(layout);
    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("tells what it removed in one line", async () => {
    const layout = fabricate();

    layout.session("old", OLD);
    layout.run("old", "scout-1", OLD);
    layout.run("old", "scout-2", OLD);

    const { host } = boot(layout);

    await vi.waitFor(() =>
      expect(host.notices).toEqual([
        { message: "retention: removed 1 session, 2 agent runs older than 60 days", level: "info" },
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

    await host.runCommand("retention");

    const report = host.notices.at(-1)?.message.split("\n") ?? [];

    expect(report[0]).toMatch(/^retention: 60 days, cutoff \d{4}-\d{2}-\d{2}T/);
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

    await host.runCommand("retention");

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

    expect(host.notices.at(-1)?.message).toBe(
      `retention: aborted, nothing would be removed: ${locked}: EACCES`,
    );
  });

  it("removes now with apply and prints the counts", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const { host } = boot(layout, { swept: true });

    await host.runCommand("retention", "apply");

    expect(existsSync(old)).toBe(false);
    expect(host.notices.at(-1)?.message).toBe("retention: removed 1 session older than 60 days");
  });

  it("says it is off when retentionDays is 0", async () => {
    const layout = fabricate();
    const { host } = boot(layout, { retentionDays: 0 });

    await host.runCommand("retention");

    expect(host.notices.at(-1)?.message).toBe("retention: off, retentionDays is 0");
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
      `retention: off until pi-retention.json loads without errors:\n  ${error}`,
    ]);
  });

  it("neither sweeps nor applies with an invalid retentionDays", async () => {
    const layout = fabricate();
    const old = layout.session("old", OLD);
    const host = bootWithSettings(layout, { retentionDays: -1 });

    await host.runCommand("retention", "apply");
    await pause(50);

    expect(existsSync(old)).toBe(true);
    expect(host.notices.at(-1)?.message).toMatch(
      /^retention: off until pi-retention.json loads without errors:/,
    );
  });
});
