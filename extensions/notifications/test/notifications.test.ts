import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAITING_INPUT_CHANNEL, BUSY_CHANNEL } from "../../../core/manager/channels.ts";
import { watchSettings } from "../../../core/manager/settings.ts";
import { createFakeHost, type FakeHost } from "../../../core/test/helpers/fakes.ts";
import type { RunMode } from "../../../pi-adapter/index.ts";
import { createNotifications } from "../src/notifications.ts";
import { defaults, SETTINGS_FILE, schema } from "../src/settings.ts";

const IDLE = { message: "pi is waiting for your input", channel: "auto" };

const roots: string[] = [];

const prepare = (mode: RunMode = "tui", file?: unknown) => {
  const root = mkdtempSync(join(tmpdir(), "pi-notifications-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");

  roots.push(root);
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  if (file !== undefined) {
    writeFileSync(join(agentDir, SETTINGS_FILE), JSON.stringify(file));
  }

  const host = createFakeHost({ mode, agentDir, cwd });

  createNotifications(host, watchSettings(host, "pi-notifications", schema, defaults, SETTINGS_FILE));

  return { host, settingsFile: join(agentDir, SETTINGS_FILE) };
};

const setup = (mode: RunMode = "tui", file?: unknown) => {
  const prepared = prepare(mode, file);

  prepared.host.start();

  return prepared.host;
};

const busy = (host: FakeHost, source: string, value: boolean) => {
  host.emit(BUSY_CHANNEL, { source, busy: value });
};

const waiting = (host: FakeHost, source: string, value: boolean, title?: string) => {
  host.emit(AWAITING_INPUT_CHANNEL, { source, waiting: value, title });
};

const advance = (ms: number) => {
  vi.advanceTimersByTime(ms);
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("idle notification", () => {
  it("fires once after the idle delay when the session settles with no busy source", () => {
    const host = setup();

    host.settle();
    advance(19_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);

    expect(host.terminalNotices).toEqual([IDLE]);

    advance(60_000);

    expect(host.terminalNotices).toEqual([IDLE]);
  });

  it("a keystroke after the settle cancels it", () => {
    const host = setup();

    host.settle();
    advance(5_000);
    host.pressKey();
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("a keystroke before the settle does not cancel it", () => {
    const host = setup();

    host.pressKey();
    host.settle();
    advance(20_000);

    expect(host.terminalNotices).toEqual([IDLE]);
  });

  it("a new run cancels it", () => {
    const host = setup();

    host.settle();
    advance(5_000);
    host.agentStart();
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("holds while a busy source is set and arms when the last source clears", () => {
    const host = setup();

    busy(host, "a", true);
    busy(host, "b", true);
    host.settle();
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);

    busy(host, "a", false);
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);

    busy(host, "b", false);
    advance(19_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);

    expect(host.terminalNotices).toEqual([IDLE]);
  });

  it("hears a busy source reported before start", () => {
    const { host } = prepare();

    busy(host, "a", true);
    host.start();
    host.settle();
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);

    busy(host, "a", false);
    advance(20_000);

    expect(host.terminalNotices).toEqual([IDLE]);
  });

  it("a busy source appearing cancels an armed timer", () => {
    const host = setup();

    host.settle();
    advance(5_000);
    busy(host, "a", true);
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);

    busy(host, "a", false);
    advance(20_000);

    expect(host.terminalNotices).toEqual([IDLE]);
  });

  it("keeps busy sources by name and treats repeated reports as one", () => {
    const host = setup();

    busy(host, "a", true);
    busy(host, "a", true);
    host.settle();
    busy(host, "a", false);
    advance(20_000);

    expect(host.terminalNotices).toEqual([IDLE]);
  });

  it("ignores busy:false from an unknown source and invalid payloads", () => {
    const host = setup();

    busy(host, "a", true);
    host.settle();
    busy(host, "x", false);
    host.emit(BUSY_CHANNEL, { source: "", busy: false });
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("a busy source clearing after a keystroke does not notify", () => {
    const host = setup();

    busy(host, "a", true);
    host.settle();
    host.pressKey();
    busy(host, "a", false);
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("a wake run between settles does not double-notify", () => {
    const host = setup();

    busy(host, "agents", true);
    host.settle();
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);

    busy(host, "agents", false);
    advance(2_000);
    host.agentStart();
    advance(30_000);

    expect(host.terminalNotices).toEqual([]);

    host.settle();
    advance(19_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);

    expect(host.terminalNotices).toEqual([IDLE]);

    advance(60_000);

    expect(host.terminalNotices).toHaveLength(1);
  });
});

describe("dialog notification", () => {
  it("notifies a waiting dialog after the dialog delay", () => {
    const host = setup();

    host.dialog("start", "confirm", "Allow bash?");
    advance(5_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);

    expect(host.terminalNotices).toEqual([{ message: "pi needs your input: Allow bash?", channel: "auto" }]);
  });

  it("each keystroke restarts the dialog timer", () => {
    const host = setup();

    host.dialog("start", "confirm", "Allow bash?");
    advance(5_000);
    host.pressKey();
    advance(5_000);

    expect(host.terminalNotices).toEqual([]);

    advance(1_000);

    expect(host.terminalNotices).toHaveLength(1);
  });

  it("the dialog ending cancels it", () => {
    const host = setup();

    host.dialog("start", "confirm", "Allow bash?");
    advance(3_000);
    host.dialog("end", "confirm");
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("notifies a dialog at most once", () => {
    const host = setup();

    host.dialog("start", "confirm", "Allow bash?");
    advance(6_000);

    expect(host.terminalNotices).toHaveLength(1);

    host.pressKey();
    advance(60_000);

    expect(host.terminalNotices).toHaveLength(1);
  });

  it("uses the short text for a dialog without a title", () => {
    const host = setup();

    host.dialog("start", "input");
    advance(6_000);

    expect(host.terminalNotices).toEqual([{ message: "pi needs your input", channel: "auto" }]);
  });

  it("ignores custom dialogs", () => {
    const host = setup();

    host.dialog("start", "custom", "Agents");
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("skips the idle notification while a dialog is open and arms it when the dialog ends", () => {
    const host = setup();
    const dialogNotice = { message: "pi needs your input: Allow?", channel: "auto" };

    host.settle();
    advance(2_000);
    host.dialog("start", "confirm", "Allow?");
    advance(18_000);

    expect(host.terminalNotices).toEqual([dialogNotice]);

    host.dialog("end", "confirm");
    advance(19_999);

    expect(host.terminalNotices).toHaveLength(1);

    advance(1);

    expect(host.terminalNotices).toEqual([dialogNotice, IDLE]);
  });

  it("a dialog ending re-arms a fresh idle delay", () => {
    const host = setup();

    host.settle();
    advance(10_000);
    host.dialog("start", "confirm", "Allow?");
    advance(1_000);
    host.dialog("end", "confirm");
    advance(19_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);

    expect(host.terminalNotices).toEqual([IDLE]);
  });

  it("a keystroke while a dialog is open cancels the pending idle notification", () => {
    const host = setup();
    const dialogNotice = { message: "pi needs your input: Allow?", channel: "auto" };

    host.settle();
    host.dialog("start", "confirm", "Allow?");
    host.pressKey();
    advance(6_000);
    host.dialog("end", "confirm");
    advance(60_000);

    expect(host.terminalNotices).toEqual([dialogNotice]);
  });
});

describe("awaiting-input notification", () => {
  const notice = { message: "pi needs your input: questionnaire", channel: "auto" };

  it("notifies a waiting source like a dialog, after the dialog delay and at most once", () => {
    const host = setup();

    waiting(host, "pi-questionnaire", true, "questionnaire");
    advance(5_000);
    host.pressKey();
    advance(5_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);
    host.pressKey();
    advance(60_000);

    expect(host.terminalNotices).toEqual([notice]);
  });

  it("another source clearing does not cancel it", () => {
    const host = setup();

    waiting(host, "pi-questionnaire", true, "questionnaire");
    waiting(host, "other", false);
    advance(6_000);

    expect(host.terminalNotices).toEqual([notice]);
  });

  it("the source clearing cancels it", () => {
    const host = setup();

    waiting(host, "pi-questionnaire", true, "questionnaire");
    advance(3_000);
    waiting(host, "pi-questionnaire", false);
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("holds the idle notification while waiting and re-arms it when waiting clears", () => {
    const host = setup();

    host.settle();
    advance(2_000);
    waiting(host, "pi-questionnaire", true, "questionnaire");
    advance(18_000);

    expect(host.terminalNotices).toEqual([notice]);

    waiting(host, "pi-questionnaire", false);
    advance(20_000);

    expect(host.terminalNotices).toEqual([notice, IDLE]);
  });

  it("still notifies a waiting source after a pi dialog opens and closes over it", () => {
    const host = setup();

    waiting(host, "pi-questionnaire", true, "questionnaire");
    advance(2_000);
    host.dialog("start", "confirm", "Allow?");
    advance(1_000);
    host.dialog("end", "confirm");
    advance(5_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);

    expect(host.terminalNotices).toEqual([notice]);
  });

  it("still notifies a pi dialog after a waiting source opens and closes over it", () => {
    const host = setup();

    host.dialog("start", "confirm", "Allow?");
    advance(2_000);
    waiting(host, "pi-questionnaire", true, "questionnaire");
    advance(1_000);
    waiting(host, "pi-questionnaire", false);
    advance(5_999);

    expect(host.terminalNotices).toEqual([]);

    advance(1);

    expect(host.terminalNotices).toEqual([{ message: "pi needs your input: Allow?", channel: "auto" }]);
  });

  it("holds the idle notification until every wait has closed", () => {
    const host = setup();

    host.settle();
    waiting(host, "pi-questionnaire", true, "questionnaire");
    host.dialog("start", "confirm", "Allow?");
    host.dialog("end", "confirm");
    advance(60_000);

    expect(host.terminalNotices).toEqual([notice]);

    waiting(host, "pi-questionnaire", false);
    advance(20_000);

    expect(host.terminalNotices).toEqual([notice, IDLE]);
  });

  it("notifies an overlapping wait and dialog once, then idles after both close", () => {
    const host = setup();

    host.settle();
    waiting(host, "pi-questionnaire", true, "questionnaire");
    host.dialog("start", "confirm", "Allow?");
    advance(6_000);

    expect(host.terminalNotices).toEqual([{ message: "pi needs your input: Allow?", channel: "auto" }]);

    host.dialog("end", "confirm");
    advance(60_000);

    expect(host.terminalNotices).toHaveLength(1);

    waiting(host, "pi-questionnaire", false);
    advance(20_000);

    expect(host.terminalNotices.at(-1)).toEqual(IDLE);
  });

  it("ignores malformed payloads", () => {
    const host = setup();

    host.emit(AWAITING_INPUT_CHANNEL, { source: "", waiting: true });
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });

  it("sends nothing for a waiting source with the off channel", () => {
    const host = setup("tui", { channel: "off" });

    waiting(host, "pi-questionnaire", true, "questionnaire");
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
  });
});

describe("channels, modes and settings", () => {
  it("rings only the bell with the bell channel", () => {
    const host = setup("tui", { channel: "bell" });

    host.settle();
    advance(20_000);

    expect(host.terminalNotices).toEqual([{ message: IDLE.message, channel: "bell" }]);
  });

  it("sends nothing with the off channel", () => {
    const host = setup("tui", { channel: "off" });

    host.settle();
    host.dialog("start", "confirm", "Allow?");
    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
    expect(host.keyListeners.size).toBe(0);
  });

  it("does nothing outside tui", () => {
    const modes: RunMode[] = ["rpc", "print", "json"];

    const results = modes.map((mode) => {
      const host = setup(mode);

      host.settle();
      host.dialog("start", "confirm", "Allow?");
      advance(60_000);

      return { notices: host.terminalNotices.length, listeners: host.keyListeners.size };
    });

    expect(results).toEqual(modes.map(() => ({ notices: 0, listeners: 0 })));
  });

  it("sends nothing after shutdown", async () => {
    const host = setup();

    host.settle();
    host.dialog("start", "confirm", "Allow?");
    await host.shutdown();

    expect(vi.getTimerCount()).toBe(0);

    advance(60_000);

    expect(host.terminalNotices).toEqual([]);
    expect(host.keyListeners.size).toBe(0);
  });

  it("uses the configured delays", () => {
    const host = setup("tui", { idleDelayMs: 0, dialogDelayMs: 1_000 });

    host.settle();
    advance(0);

    expect(host.terminalNotices).toEqual([IDLE]);

    host.dialog("start", "confirm", "Allow?");
    advance(1_000);

    expect(host.terminalNotices).toHaveLength(2);
  });

  it("warns once about invalid settings and keeps the defaults", () => {
    const { host, settingsFile } = prepare("tui", { channel: "loud", idleDelayMs: -1 });

    host.start();
    host.start();

    expect(host.keyListeners.size).toBe(1);
    expect(host.notices).toEqual([
      {
        message: `pi-notifications settings: ${settingsFile}: channel must be one of "auto", "bell", "off"`,
        level: "warning",
      },
      {
        message: `pi-notifications settings: ${settingsFile}: idleDelayMs must be a number between 0 and 600000`,
        level: "warning",
      },
    ]);

    host.settle();
    advance(20_000);

    expect(host.terminalNotices).toEqual([IDLE]);
  });
});
