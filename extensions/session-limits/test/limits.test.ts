import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { RunMode } from "../../../core/adapter/contract.ts";
import { BUSY_CHANNEL } from "../../../core/manager/channels.ts";
import { createFakeHost, flushTimers as flush } from "../../../core/test/helpers/fakes.ts";
import { conversationOnly } from "../src/conversation.ts";
import { createLimits } from "../src/limits.ts";
import { DEFAULT_LIMITS } from "../src/settings.ts";

const created: string[] = [];

const tempRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "pi-session-limits-"));

  created.push(root, join(tmpdir(), "pi-session-limits", `${basename(root)}-handoff.md`));

  return root;
};

afterAll(() => {
  created.forEach((path) => {
    rmSync(path, { recursive: true, force: true });
  });
});

const LIMITS = DEFAULT_LIMITS;

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

const STATUS_KEY = "pi-session-limits";
const HANDOFF_COMMAND = "session-handoff";
const HANDOFF_TYPE = "pi-session-limits-handoff";

const RELEASE_MS = 1_000;

const setup = (releaseDelayMs = 0, limits = LIMITS, mode: RunMode = "tui") => {
  const root = tempRoot();
  const file = join(root, "sessions", "main.jsonl");

  const host = createFakeHost({
    id: basename(root),
    file,
    cwd: join(root, "project"),
    agentDir: join(root, "agent"),
    projectTrusted: false,
    mode,
  });

  createLimits({ host: conversationOnly(host), template: TEMPLATE, limits: () => limits, releaseDelayMs });

  host.start();

  const handoffPath = join(tmpdir(), "pi-session-limits", `${basename(root)}-handoff.md`);

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

  const requests = () => host.hidden.map((entry) => entry.message.text);

  const warnings = () => host.notices.filter((notice) => notice.level === "warning");

  const busy = (value: boolean, source = "pi-subagents") => host.emit(BUSY_CHANNEL, { source, busy: value });

  return { host, handoffPath, writeHandoff, writeNewerHandoff, turn, status, busy, requests, warnings };
};

describe("session limits", () => {
  it("colours the footer segment by soft and hard limit", () => {
    const { turn, status } = setup();

    turn(40_000);
    expect(status()).toBeUndefined();

    turn(50_000);
    expect(status()).toBe("<warning>ctx 50% · handoff at 60%");

    turn(40_000);
    expect(status()).toBeUndefined();

    turn(76_000);
    expect(status()).toBe("<error>ctx 76% · writing handoff");
  });

  it("requests the handoff at the token cap on a large window", () => {
    const { host, requests, status } = setup(0, { ...LIMITS, softTokens: 125_000, hardTokens: 175_000 });

    host.turnEnd({ tokens: 160_000, window: 1_000_000 });
    expect(status()).toBe("<warning>ctx 160k · handoff at 175k");
    expect(requests()).toHaveLength(0);

    host.turnEnd({ tokens: 175_000, window: 1_000_000 });
    expect(requests()).toHaveLength(1);
    expect(status()).toBe("<error>ctx 17% · writing handoff");
  });

  it("sends the handoff instruction once as a hidden message and says so once", () => {
    const { host, requests, turn, handoffPath } = setup();

    turn(76_000);
    turn(80_000);

    expect(requests()).toHaveLength(1);
    expect(requests()[0]).toContain(handoffPath);
    expect(requests()[0]).not.toContain("{{path}}");
    ["Status", "Outcome", "Evidence", "Blocker", "Next", "Files touched"].forEach((section) => {
      expect(requests()[0]).toContain(`## ${section}`);
    });
    expect(requests()[0]).toContain("Do not start new work in this turn");
    expect(requests()[0]).toContain("write tool");
    expect(requests()[0]).not.toMatch(/agent/i);
    expect(requests()[0].startsWith("Your context window is nearly full.")).toBe(true);
    expect(requests()[0]).not.toContain("{{");
    expect(requests()[0]).not.toContain("next session is for");
    expect(requests()[0]).not.toContain("/session-handoff");
    expect(host.hidden[0].message.customType).toBe("pi-session-limits-request");
    expect(host.sent).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: `Context is nearly full; writing a session handoff to ${handoffPath}, then switching to a new session.`,
        level: "info",
      },
    ]);
  });

  it("switches to a new session seeded from a valid handoff on idle", async () => {
    const { host, requests, turn, writeHandoff, status } = setup();

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].parentSession).toBe(host.info.file);
    expect(host.newSessions[0].seed?.customType).toBe(HANDOFF_TYPE);
    expect(host.newSessions[0].seed?.text).toContain(`the previous session ${host.info.file}`);
    expect(host.newSessions[0].seed?.text).toContain(VALID_HANDOFF);
    expect(host.confirmations).toEqual([]);
    expect(requests()).toHaveLength(1);
    expect(status()).toBe("<error>ctx 76% · switching session");
  });

  it("waits while a source reports running work and switches once it is released", async () => {
    const { host, requests, turn, writeHandoff, status, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([]);
    expect(status()).toBe("<warning>ctx 76% · handoff waits for running work");

    busy(false);
    await flush();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.newSessions).toHaveLength(1);
    expect(host.confirmations).toEqual([]);
    expect(requests()).toHaveLength(1);
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
    const { host, requests, turn, writeHandoff, writeNewerHandoff, busy } = setup();

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

    expect(requests()).toHaveLength(2);
    expect(host.dispatched).toEqual([]);

    turn(78_000);
    writeNewerHandoff(VALID_HANDOFF.replace("write the test plan", "write the release notes"));
    host.settle();
    await flush();

    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain("write the release notes");
  });

  it("asks for a fresh handoff when the user spoke while the switch waited", async () => {
    const { host, requests, turn, writeHandoff, writeNewerHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    turn(78_000);
    host.settle();
    busy(false);
    await flush();
    await flush();

    expect(requests()).toHaveLength(2);
    expect(host.dispatched).toEqual([]);

    turn(80_000);
    writeNewerHandoff(VALID_HANDOFF.replace("write the test plan", "write the release notes"));
    host.settle();
    await flush();

    expect(host.dispatched).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain("write the release notes");
    expect(requests()).toHaveLength(2);
  });

  it("switches without a fresh request when only the instruction produced turns", async () => {
    const { host, requests, turn, writeHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    turn(78_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    busy(false);
    await flush();
    await flush();

    expect(requests()).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
  });

  it("keeps the single resend after a fresh request", async () => {
    const { host, requests, turn, writeHandoff, writeNewerHandoff, busy } = setup();

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

    expect(requests()).toHaveLength(3);
    expect(requests()[2]).toContain("missing sections");
    expect(host.notices.filter((notice) => notice.level === "warning")).toEqual([]);
    expect(host.notices).toHaveLength(1);
    expect(host.dispatched).toEqual([]);
  });

  it("resends once with the validation errors, then warns and stops", async () => {
    const { host, warnings, requests, turn, writeHandoff, handoffPath, status } = setup();

    turn(76_000);
    writeHandoff("## Status\npartial\n");
    host.settle();

    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toContain(handoffPath);
    expect(requests()[1]).toContain("missing sections");

    host.settle();
    host.settle();
    turn(90_000);
    await flush();

    expect(requests()).toHaveLength(2);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].level).toBe("warning");
    expect(warnings()[0].message).toContain(handoffPath);
    expect(warnings()[0].message).toContain(`/${HANDOFF_COMMAND}`);
    expect(host.dispatched).toEqual([]);
    expect(status()).toBe(`<error>ctx 90% · handoff failed, run /${HANDOFF_COMMAND}`);
  });

  it("ignores a stale handoff file left from before the request", () => {
    const { host, requests, turn, writeHandoff } = setup();

    writeHandoff(VALID_HANDOFF);
    turn(76_000);
    host.settle();

    expect(host.dispatched).toEqual([]);
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toContain("no new handoff file");
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
    const { host, warnings, turn, writeHandoff, status } = setup();

    host.newSessionResult = false;
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();
    host.settle();
    await flush();

    expect(host.dispatched).toHaveLength(1);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].level).toBe("warning");
    expect(warnings()[0].message).toContain("cancelled");
    expect(status()).toContain("<error>");
  });

  it("warns and keeps the file when the new session fails", async () => {
    const { host, warnings, turn, writeHandoff, handoffPath, status } = setup();

    host.newSessionResult = new Error("disk full");
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toContain("disk full");
    expect(warnings()[0].message).toContain(handoffPath);
    expect(status()).toContain("handoff failed");
  });

  it("clears the footer segment when the usage becomes unknown", () => {
    const { turn, status } = setup();

    turn(50_000);
    expect(status()).toBe("<warning>ctx 50% · handoff at 60%");

    turn(null);
    expect(status()).toBeUndefined();
  });

  it("leaves the switching phase when the dispatched command never runs", async () => {
    const { host, turn, writeHandoff, status } = setup();

    host.commands.set(HANDOFF_COMMAND, { description: "", run: () => undefined });
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(status()).toBe("<error>ctx 76% · switching session");

    host.settle();

    expect(status()).toBe(`<error>ctx 76% · handoff failed, run /${HANDOFF_COMMAND}`);
  });

  it("ignores a second command while the first one waits for the confirmation", async () => {
    const { host, turn, writeHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await Promise.all([host.runCommand(HANDOFF_COMMAND), host.runCommand(HANDOFF_COMMAND)]);

    expect(host.confirmations).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
  });

  it("does nothing while the context is unknown", () => {
    const { host, requests, turn, status } = setup();

    turn(null);
    host.turnEnd({ tokens: 90_000, window: 0 });
    host.settle();

    expect(requests()).toEqual([]);
    expect(host.dispatched).toEqual([]);
    expect(status()).toBeUndefined();
  });

  it("hides the stale context segment after compaction until the next turn", () => {
    const { host, turn, status } = setup();

    turn(50_000);
    host.compact();

    expect(status()).toBeUndefined();

    turn(51_000);

    expect(status()).toBe("<warning>ctx 51% · handoff at 60%");
  });

  it("keeps a busy signal that a source announced in its own session start", () => {
    const root = tempRoot();

    const host = createFakeHost({
      id: basename(root),
      file: join(root, "sessions", "main.jsonl"),
      cwd: join(root, "project"),
      agentDir: join(root, "agent"),
      projectTrusted: false,
    });

    host.onSessionStart(() => host.emit(BUSY_CHANNEL, { source: "pi-subagents", busy: true }));

    createLimits({ host, template: TEMPLATE, limits: () => LIMITS, releaseDelayMs: 0 });

    host.start();
    host.turnEnd({ tokens: 76_000, window: 100_000 });
    const handoffPath = join(tmpdir(), "pi-session-limits", `${basename(root)}-handoff.md`);

    mkdirSync(dirname(handoffPath), { recursive: true });
    writeFileSync(handoffPath, VALID_HANDOFF);
    host.settle();

    expect(host.dispatched).toEqual([]);
    expect(host.statuses.get(STATUS_KEY)).toBe("<warning>ctx 76% · handoff waits for running work");
  });

  it("ignores malformed busy signals", () => {
    const { host, turn, writeHandoff } = setup();

    host.emit(BUSY_CHANNEL, { busy: true });
    host.emit(BUSY_CHANNEL, "busy");
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
  });

  it("switches now behind the busy confirm when the command runs while the switch waits", async () => {
    const { host, requests, turn, writeHandoff, busy, status } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
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
    expect(status()).toBe("<warning>ctx 76% · handoff waits for running work");

    host.confirmAnswer = true;
    await host.runCommand(HANDOFF_COMMAND);

    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain("which reached its context limit");
    expect(requests()).toHaveLength(1);
  });
});

describe("/session-handoff on demand", () => {
  const FOCUS = "fix the flaky login test";

  it("asks the model for a handoff with the focus and says so", async () => {
    const { host, requests, handoffPath, turn, status } = setup();

    turn(34_000);
    await host.runCommand(HANDOFF_COMMAND, FOCUS);

    expect(requests()).toHaveLength(1);
    expect(host.hidden[0].message.customType).toBe("pi-session-limits-request");
    expect(requests()[0]).toContain(handoffPath);
    expect(requests()[0].startsWith("The user ran /session-handoff to continue in a fresh session.")).toBe(
      true,
    );
    expect(requests()[0]).toContain(
      `The user says the next session is for: ${FOCUS}. Shape Outcome and Next around that`,
    );
    expect(requests()[0]).toContain("[redacted]");
    expect(requests()[0]).toContain("Skills:");
    expect(requests()[0]).not.toContain("{{");
    expect(host.sent).toEqual([]);
    expect(host.notices).toEqual([
      {
        message: `Writing a session handoff to ${handoffPath}; the session switches to a new one when it is ready.`,
        level: "info",
      },
    ]);
    expect(status()).toBe("<error>ctx 34% · writing handoff");
  });

  it("shows the label alone while the context size is unknown and leaves out an empty focus", async () => {
    const { host, requests, status } = setup();

    await host.runCommand(HANDOFF_COMMAND, "   ");

    expect(status()).toBe("<error>writing handoff");
    expect(requests()[0]).not.toContain("next session is for");
    expect(requests()[0]).toMatch(/now, so this is your very next step\.\nWrite the handoff file/);
  });

  it("switches after a valid file and seeds the new session with the focus", async () => {
    const { host, writeHandoff } = setup();

    await host.runCommand(HANDOFF_COMMAND, FOCUS);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain("which the user handed off with /session-handoff");
    expect(host.newSessions[0].seed?.text).toContain(`The user said this session is for: ${FOCUS}.`);
    expect(host.newSessions[0].seed?.text).toContain(VALID_HANDOFF);
  });

  it("resends once with the errors, then warns and shows the failure", async () => {
    const { host, requests, warnings, writeHandoff, status } = setup();

    await host.runCommand(HANDOFF_COMMAND, FOCUS);
    writeHandoff("## Status\npartial\n");
    host.settle();

    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toContain("missing sections");
    expect(requests()[1]).toContain(FOCUS);

    host.settle();

    expect(requests()).toHaveLength(2);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toContain("Session handoff failed");
    expect(status()).toContain("handoff failed");
  });

  it("says a handoff is already being written and sends nothing more", async () => {
    const { host, requests } = setup();

    await host.runCommand(HANDOFF_COMMAND, FOCUS);
    await host.runCommand(HANDOFF_COMMAND, "something else");

    expect(requests()).toHaveLength(1);
    expect(host.notices.at(-1)).toEqual({
      message: "A session handoff is already being written; the session switches when it is ready.",
      level: "info",
    });
  });

  it("confirms a manual switch while work runs, and waits for it on No", async () => {
    const { host, writeHandoff, busy, status } = setup();

    busy(true);
    host.confirmAnswer = false;
    await host.runCommand(HANDOFF_COMMAND, FOCUS);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
    expect(host.confirmations).toHaveLength(1);
    expect(host.newSessions).toEqual([]);
    expect(status()).toBe("<warning>handoff waits for running work");

    busy(false);
    await flush();
    await flush();

    expect(host.confirmations).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain(`The user said this session is for: ${FOCUS}.`);
  });

  it("switches at once after a cancelled switch when the file is still valid", async () => {
    const { host, requests, writeHandoff, status } = setup();

    host.newSessionResult = false;
    await host.runCommand(HANDOFF_COMMAND);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(status()).toContain("handoff failed");

    host.newSessionResult = true;
    await host.runCommand(HANDOFF_COMMAND);

    expect(host.newSessions).toHaveLength(2);
    expect(requests()).toHaveLength(1);
  });

  it("asks for a fresh handoff after a cancelled switch when a focus is given", async () => {
    const { host, requests, writeHandoff, status } = setup();

    host.newSessionResult = false;
    await host.runCommand(HANDOFF_COMMAND);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();
    await host.runCommand(HANDOFF_COMMAND, FOCUS);

    expect(host.newSessions).toHaveLength(1);
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toContain(FOCUS);
    expect(status()).toBe("<error>writing handoff");
  });

  it("asks for a fresh handoff when stuck without a valid file", async () => {
    const { host, requests } = setup();

    await host.runCommand(HANDOFF_COMMAND);
    host.settle();
    host.settle();
    await host.runCommand(HANDOFF_COMMAND);

    expect(requests()).toHaveLength(3);
    expect(host.newSessions).toEqual([]);
  });

  it("asks for a fresh handoff when a focus is given while the switch waits", async () => {
    const { host, requests, turn, writeHandoff, busy } = setup();

    busy(true);
    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await host.runCommand(HANDOFF_COMMAND, FOCUS);

    expect(host.confirmations).toEqual([]);
    expect(requests()).toHaveLength(2);
    expect(requests()[1]).toContain(FOCUS);
  });

  it("does nothing outside the conversational modes", async () => {
    const { host, requests } = setup(0, LIMITS, "print");

    await host.runCommand(HANDOFF_COMMAND, FOCUS);

    expect(requests()).toEqual([]);
    expect(host.notices).toEqual([]);
    expect(host.newSessions).toEqual([]);
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
    expect(status()).toBe("<warning>ctx 76% · handoff waits for running work");

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
    expect(status()).toBe("<warning>ctx 76% · handoff waits for running work");
  });

  it("holds the switch when a source turns busy again before the timer fires", async () => {
    const { host, busy } = waitingSetup();

    busy(false);
    await vi.advanceTimersByTimeAsync(RELEASE_MS / 2);
    busy(true);
    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(host.dispatched).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    busy(false);
    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(host.dispatched).toEqual([HANDOFF_COMMAND]);
  });

  it("is cancelled by session shutdown", async () => {
    const { host, busy } = waitingSetup();

    busy(false);
    await host.shutdown();

    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(RELEASE_MS);

    expect(host.dispatched).toEqual([]);
  });
});
