import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUSY_CHANNEL,
  createLimits,
  HANDOFF_COMMAND,
  HANDOFF_TYPE,
  parseBusySignal,
  STATUS_KEY,
} from "../src/limits.ts";
import { defaultRatios } from "../src/settings.ts";
import { createFakeHost, flush } from "./helpers/fake-host.ts";

const TEMPLATE = readFileSync(resolve(import.meta.dirname, "..", "prompts", "handoff.md"), "utf8");

const VALID_HANDOFF = [
  "## Status",
  "partial",
  "",
  "## Outcome",
  "- goal: migrate the auth module; the user asked for a test plan last",
  "",
  "## Evidence",
  "- background search: done, results in /tmp/result.md",
  "",
  "## Blocker",
  "none",
  "",
  "## Next",
  "- write the test plan",
  "",
  "## Files touched",
  "none",
].join("\n");

const RELEASE_MS = 1_000;

const setup = (releaseDelayMs = 0) => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-limits-"));
  const file = join(root, "sessions", "main.jsonl");

  const host = createFakeHost({
    id: "main-session",
    file,
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
    projectTrusted: false,
  });

  const limits = createLimits({ host, template: TEMPLATE, ratios: defaultRatios, releaseDelayMs });

  host.start();

  const handoffPath = join(root, "sessions", "main", "main-handoff.md");

  const writeHandoff = (text: string) => {
    mkdirSync(dirname(handoffPath), { recursive: true });
    writeFileSync(handoffPath, text);
  };

  const writeNewerHandoff = (text: string) => {
    writeHandoff(text);
    utimesSync(handoffPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  };

  const turn = (tokens: number | null) => host.turnEnd({ tokens, window: 100_000 });

  const status = () => host.statuses.get(STATUS_KEY);

  const busy = (value: boolean, source = "pi-subagents") => host.emit(BUSY_CHANNEL, { source, busy: value });

  return { host, limits, handoffPath, writeHandoff, writeNewerHandoff, turn, status, busy };
};

describe("parseBusySignal", () => {
  it("accepts a source name and a busy flag only", () => {
    expect(parseBusySignal({ source: "pi-subagents", busy: true })).toEqual({
      source: "pi-subagents",
      busy: true,
    });
    expect(parseBusySignal({ source: "", busy: true })).toBeUndefined();
    expect(parseBusySignal({ source: "x", busy: "yes" })).toBeUndefined();
    expect(parseBusySignal(null)).toBeUndefined();
    expect(parseBusySignal("busy")).toBeUndefined();
  });
});

describe("session limits", () => {
  it("colours the footer segment by soft and hard limit", () => {
    const { turn, status } = setup();

    turn(50_000);
    expect(status()).toBeUndefined();

    turn(62_000);
    expect(status()).toBe("<warning>ctx 62% · handoff at 75%");

    turn(40_000);
    expect(status()).toBeUndefined();

    turn(76_000);
    expect(status()).toBe("<error>ctx 76% · writing handoff");
  });

  it("sends the handoff instruction once as the next user message", () => {
    const { host, turn, handoffPath } = setup();

    turn(76_000);
    turn(80_000);

    expect(host.sent).toHaveLength(1);
    expect(host.sent[0]).toContain(handoffPath);
    expect(host.sent[0]).toContain("Do not start new work in this turn");
    expect(host.sent[0]).toContain("write tool");
    expect(host.sent[0]).not.toMatch(/agent/i);
    expect(host.notices).toEqual([]);
  });

  it("switches to a new session seeded from a valid handoff on idle", async () => {
    const { host, turn, writeHandoff, status } = setup();

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].parentSession).toBe(host.info.file);
    expect(host.newSessions[0].seed.customType).toBe(HANDOFF_TYPE);
    expect(host.newSessions[0].seed.text).toContain(`the previous session ${host.info.file}`);
    expect(host.newSessions[0].seed.text).toContain(VALID_HANDOFF);
    expect(host.confirmations).toEqual([]);
    expect(host.sent).toHaveLength(1);
    expect(status()).toBe("<error>ctx 76% · switching session");
  });

  it("waits while a source reports running work and switches once it is released", async () => {
    const { host, limits, turn, writeHandoff, status, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(limits.busySources()).toEqual(["pi-subagents"]);
    expect(host.dispatched).toEqual([]);
    expect(status()).toBe("<error>ctx 76% · handoff waits for running work");

    busy(false);
    await flush();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.newSessions).toHaveLength(1);
    expect(host.confirmations).toEqual([]);
    expect(host.sent).toHaveLength(1);
  });

  it("keeps waiting until every source is released", async () => {
    const { host, turn, writeHandoff, busy } = setup();

    busy(true, "a");
    busy(true, "b");
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    busy(false, "a");
    await flush();
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([]);

    busy(false, "b");
    await flush();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
  });

  it("leaves the switch to the next settle when a turn follows the release", async () => {
    const { host, turn, writeHandoff, writeNewerHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    busy(false);
    turn(77_000);
    await flush();

    expect(host.dispatched).toEqual([]);

    host.settle();
    await flush();

    expect(host.sent).toHaveLength(2);
    expect(host.dispatched).toEqual([]);

    turn(78_000);
    writeNewerHandoff(VALID_HANDOFF.replace("write the test plan", "write the release notes"));
    host.settle();
    await flush();

    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed.text).toContain("write the release notes");
  });

  it("asks for a fresh handoff when the user spoke while the switch waited", async () => {
    const { host, turn, writeHandoff, writeNewerHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    turn(78_000);
    host.settle();
    busy(false);
    await flush();
    await flush();

    expect(host.sent).toHaveLength(2);
    expect(host.dispatched).toEqual([]);

    turn(80_000);
    writeNewerHandoff(VALID_HANDOFF.replace("write the test plan", "write the release notes"));
    host.settle();
    await flush();

    expect(host.dispatched).toHaveLength(1);
    expect(host.newSessions[0].seed.text).toContain("write the release notes");
    expect(host.sent).toHaveLength(2);
  });

  it("switches without a fresh request when only the instruction produced turns", async () => {
    const { host, turn, writeHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    turn(78_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    busy(false);
    await flush();
    await flush();

    expect(host.sent).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
  });

  it("keeps the single resend after a fresh request", async () => {
    const { host, turn, writeHandoff, writeNewerHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    turn(78_000);
    busy(false);
    host.settle();
    writeNewerHandoff("## Status\npartial\n");
    host.settle();
    await flush();

    expect(host.sent).toHaveLength(3);
    expect(host.sent[2]).toContain("missing sections");
    expect(host.notices).toEqual([]);
    expect(host.dispatched).toEqual([]);
  });

  it("resends once with the validation errors, then warns and stops", async () => {
    const { host, turn, writeHandoff, handoffPath, status } = setup();

    turn(76_000);
    writeHandoff("## Status\npartial\n");
    host.settle();

    expect(host.sent).toHaveLength(2);
    expect(host.sent[1]).toContain(handoffPath);
    expect(host.sent[1]).toContain("missing sections");

    host.settle();
    host.settle();
    turn(90_000);
    await flush();

    expect(host.sent).toHaveLength(2);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].level).toBe("warning");
    expect(host.notices[0].message).toContain(handoffPath);
    expect(host.notices[0].message).toContain(`/${HANDOFF_COMMAND}`);
    expect(host.dispatched).toEqual([]);
    expect(status()).toBe(`<error>ctx 90% · handoff failed, run /${HANDOFF_COMMAND}`);
  });

  it("ignores a stale handoff file left from before the request", () => {
    const { host, turn, writeHandoff } = setup();

    writeHandoff(VALID_HANDOFF);
    turn(76_000);
    host.settle();

    expect(host.dispatched).toEqual([]);
    expect(host.sent).toHaveLength(2);
    expect(host.sent[1]).toContain("no new handoff file");
  });

  it("accepts a rewritten handoff file even when the old one was valid", async () => {
    const { host, turn, writeHandoff, handoffPath } = setup();

    writeHandoff(VALID_HANDOFF);
    utimesSync(handoffPath, new Date(2020, 0, 1), new Date(2020, 0, 1));
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.newSessions).toHaveLength(1);
  });

  it("warns once and stays red when the new session is cancelled", async () => {
    const { host, turn, writeHandoff, status } = setup();

    host.newSessionResult = false;
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();
    host.settle();
    await flush();

    expect(host.dispatched).toHaveLength(1);
    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].level).toBe("warning");
    expect(host.notices[0].message).toContain("cancelled");
    expect(status()).toContain("<error>");
  });

  it("warns and keeps the file when the new session fails", async () => {
    const { host, turn, writeHandoff, handoffPath, status } = setup();

    host.newSessionResult = new Error("disk full");
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.notices).toHaveLength(1);
    expect(host.notices[0].message).toContain("disk full");
    expect(host.notices[0].message).toContain(handoffPath);
    expect(status()).toContain("handoff failed");
  });

  it("does nothing while the context is unknown", () => {
    const { host, turn, status } = setup();

    turn(null);
    host.turnEnd({ tokens: 90_000, window: 0 });
    host.settle();

    expect(host.sent).toEqual([]);
    expect(host.dispatched).toEqual([]);
    expect(status()).toBeUndefined();
  });

  it("resets the phase on session start", () => {
    const { host, turn, status } = setup();

    turn(76_000);
    host.start();

    expect(status()).toBeUndefined();

    turn(76_000);

    expect(host.sent).toHaveLength(2);
  });

  it("keeps a busy signal that a source announced in its own session start", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-session-limits-"));

    const host = createFakeHost({
      id: "main-session",
      file: join(root, "sessions", "main.jsonl"),
      cwd: join(root, "project"),
      agentDir: join(root, "agent"),
      projectTrusted: false,
    });

    host.onSessionStart(() => host.emit(BUSY_CHANNEL, { source: "pi-subagents", busy: true }));

    const limits = createLimits({ host, template: TEMPLATE, ratios: defaultRatios, releaseDelayMs: 0 });

    host.start();

    expect(limits.busySources()).toEqual(["pi-subagents"]);
  });

  it("ignores malformed busy signals", () => {
    const { host, limits } = setup();

    host.emit(BUSY_CHANNEL, { busy: true });
    host.emit(BUSY_CHANNEL, "busy");

    expect(limits.busySources()).toEqual([]);
  });

  it("lets the user run the command by hand", async () => {
    const { host, writeHandoff, handoffPath } = setup();

    await host.runCommand(HANDOFF_COMMAND);

    expect(host.newSessions).toEqual([]);
    expect(host.notices[0].message).toContain(handoffPath);

    writeHandoff(VALID_HANDOFF);
    await host.runCommand(HANDOFF_COMMAND);

    expect(host.newSessions).toHaveLength(1);
    expect(host.sent).toEqual([]);
  });

  it("asks before a manual switch while sources report running work", async () => {
    const { host, writeHandoff, busy } = setup();

    writeHandoff(VALID_HANDOFF);
    busy(true);
    host.confirmAnswer = false;
    await host.runCommand(HANDOFF_COMMAND);

    expect(host.confirmations).toEqual([
      {
        title: "Switch to a new session?",
        message:
          "Work reported by pi-subagents is still running and will be ended by the switch. Switch anyway?",
      },
    ]);
    expect(host.newSessions).toEqual([]);

    host.confirmAnswer = true;
    await host.runCommand(HANDOFF_COMMAND);

    expect(host.newSessions).toHaveLength(1);
  });
});

describe("session limits around the dispatch window", () => {
  it("goes back to waiting when a source turns busy before the switch runs and the user declines", async () => {
    const { host, turn, writeHandoff, status, busy } = setup();
    let announced = false;

    host.onIdle(() => {
      if (!announced && host.dispatched.length > 0) {
        announced = true;
        busy(true);
      }
    });

    host.confirmAnswer = false;
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.confirmations).toHaveLength(1);
    expect(host.newSessions).toEqual([]);
    expect(status()).toBe("<error>ctx 76% · handoff waits for running work");

    busy(false);
    await flush();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND, HANDOFF_COMMAND]);
    expect(host.confirmations).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
  });

  it("runs a command dispatched during settle only after every settle handler", async () => {
    const { host, turn, writeHandoff } = setup();
    const order: string[] = [];

    host.onIdle(() => {
      order.push(`idle handler, sessions ${host.newSessions.length}`);
    });

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(order).toEqual(["idle handler, sessions 0"]);
    expect(host.newSessions).toHaveLength(1);
  });
});

describe("release timer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const waitingSetup = () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const context = setup(RELEASE_MS);

    context.busy(true);
    context.turn(76_000);
    context.writeHandoff(VALID_HANDOFF);
    context.host.settle();

    return context;
  };

  it("switches once the delay passes with the session idle", async () => {
    const { host, busy } = waitingSetup();

    busy(false);
    await vi.advanceTimersByTimeAsync(RELEASE_MS - 1);

    expect(host.dispatched).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.newSessions).toHaveLength(1);
  });

  it("does nothing when the session is not idle when the timer fires", async () => {
    const { host, busy, status } = waitingSetup();

    busy(false);
    host.idle = false;
    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(host.dispatched).toEqual([]);
    expect(status()).toBe("<error>ctx 76% · handoff waits for running work");
  });

  it("holds the switch when a source turns busy again before the timer fires", async () => {
    const { host, limits, busy } = waitingSetup();

    busy(false);
    await vi.advanceTimersByTimeAsync(RELEASE_MS / 2);
    busy(true);
    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(limits.busySources()).toEqual(["pi-subagents"]);
    expect(host.dispatched).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    busy(false);
    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
  });

  it("is cancelled by session shutdown", async () => {
    const { host, busy } = waitingSetup();

    busy(false);
    host.shutdown();

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(host.dispatched).toEqual([]);
  });

  it("is cancelled by session start", async () => {
    const { host, busy } = waitingSetup();

    busy(false);
    host.start();

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(host.dispatched).toEqual([]);
  });
});
