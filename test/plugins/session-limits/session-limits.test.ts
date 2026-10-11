import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAIN_CALLER } from "../../../src/manager/types.ts";
import { agentRegistryPlugin } from "../../../src/plugins/agent-registry/index.ts";
import { handoffPlugin } from "../../../src/plugins/handoff/index.ts";
import {
  CONTEXT_STATUS_KEY,
  HANDOFF_COMMAND,
  MAIN_HANDOFF_TYPE,
  sessionLimitsPlugin,
} from "../../../src/plugins/session-limits/index.ts";
import { flush } from "../../helpers/fakes.ts";
import { createHarness } from "../../helpers/harness.ts";

const VALID_HANDOFF = [
  "## Status",
  "partial",
  "",
  "## Outcome",
  "- goal: migrate the auth module; the user asked for a test plan last",
  "",
  "## Evidence",
  "- explorer-1a2b (explorer): done, result: /tmp/result.md",
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

const setup = () => {
  const harness = createHarness([agentRegistryPlugin, handoffPlugin, sessionLimitsPlugin]);
  const { host } = harness;

  host.ui.style = (token, text) => `<${token}>${text}`;

  const handoffPath = join(dirname(host.info.file ?? ""), "main", "main-handoff.md");

  const writeHandoff = (text: string) => {
    mkdirSync(dirname(handoffPath), { recursive: true });
    writeFileSync(handoffPath, text);
  };

  const turn = (tokens: number | null) => host.turnEnd({ tokens, window: 100_000, percent: null });

  const status = () => host.statuses.get(CONTEXT_STATUS_KEY);

  const writeNewerHandoff = (text: string) => {
    writeHandoff(text);
    utimesSync(handoffPath, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  };

  const openAgent = () =>
    harness.services.require("registry").create({
      agent: "explorer",
      task: "search",
      description: "search",
      callerId: MAIN_CALLER,
      depth: 1,
      batchId: "batch-1",
      dir: join(harness.root, "agents"),
      budgetTokens: 100_000,
    });

  return { ...harness, handoffPath, writeHandoff, writeNewerHandoff, openAgent, turn, status };
};

describe("session-limits plugin", () => {
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
    expect(host.sent[0]).toContain("Do not start new agents");
    expect(host.sent[0]).toContain("write tool");
    expect(host.notices).toEqual([]);
  });

  it("switches to a new session seeded from a valid handoff on idle", async () => {
    const { host, turn, writeHandoff, status } = setup();

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([{ name: HANDOFF_COMMAND, args: undefined }]);
    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].parentSession).toBe(host.info.file);
    expect(host.newSessions[0].seed?.customType).toBe(MAIN_HANDOFF_TYPE);
    expect(host.newSessions[0].seed?.text).toContain(`the previous session ${host.info.file}`);
    expect(host.newSessions[0].seed?.text).toContain(VALID_HANDOFF);
    expect(host.sent).toHaveLength(1);
    expect(status()).toBe("<error>ctx 76% · switching session");
  });

  it("defers the switch while an agent is open and switches once it closes", async () => {
    const { host, root, services, turn, writeHandoff, status } = setup();
    const registry = services.require("registry");

    const record = registry.create({
      agent: "explorer",
      task: "search",
      description: "search",
      callerId: MAIN_CALLER,
      depth: 1,
      batchId: "batch-1",
      dir: join(root, "agents"),
      budgetTokens: 100_000,
    });

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    await flush();

    expect(host.dispatched).toEqual([]);
    expect(status()).toBe("<error>ctx 76% · handoff waits for agents");

    registry.close(record.id, { state: "done", resultPath: "/tmp/late.md", endedAt: Date.now() + 60_000 });
    host.settle();
    await flush();

    expect(host.dispatched).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain(`- ${record.id} (explorer): done, result: /tmp/late.md`);
    expect(host.sent).toHaveLength(1);
  });

  it("asks for a fresh handoff when the user spoke while the switch waited for agents", async () => {
    const { host, services, turn, writeHandoff, writeNewerHandoff, openAgent } = setup();
    const registry = services.require("registry");
    const record = openAgent();

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    turn(78_000);
    registry.close(record.id, { state: "done", endedAt: Date.now() });
    host.settle();
    await flush();

    expect(host.sent).toHaveLength(2);
    expect(host.dispatched).toEqual([]);

    turn(80_000);
    writeNewerHandoff(VALID_HANDOFF.replace("write the test plan", "write the release notes"));
    host.settle();
    await flush();

    expect(host.dispatched).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain("write the release notes");
    expect(host.sent).toHaveLength(2);
  });

  it("switches without a fresh request when only the instruction produced turns", async () => {
    const { host, services, turn, writeHandoff, openAgent } = setup();
    const registry = services.require("registry");
    const record = openAgent();

    turn(76_000);
    turn(78_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    registry.close(record.id, { state: "done", endedAt: Date.now() });
    host.settle();
    await flush();

    expect(host.sent).toHaveLength(1);
    expect(host.newSessions).toHaveLength(1);
  });

  it("keeps the single resend after a fresh request", async () => {
    const { host, services, turn, writeHandoff, writeNewerHandoff, openAgent } = setup();
    const registry = services.require("registry");
    const record = openAgent();

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    turn(78_000);
    registry.close(record.id, { state: "done", endedAt: Date.now() });
    host.settle();
    writeNewerHandoff("## Status\npartial\n");
    host.settle();
    await flush();

    expect(host.sent).toHaveLength(3);
    expect(host.sent[2]).toContain("missing sections");
    expect(host.notices).toEqual([]);
    expect(host.dispatched).toEqual([]);
  });

  it("leaves predecessor chain links out of the late agents in the seed", async () => {
    const { host, services, turn, writeHandoff, openAgent } = setup();
    const registry = services.require("registry");
    const predecessor = openAgent();
    const successor = openAgent();

    turn(76_000);
    writeHandoff(VALID_HANDOFF);
    host.settle();
    registry.update(predecessor.id, { successorId: successor.id });
    registry.close(predecessor.id, { state: "handoff", endedAt: Date.now() + 60_000 });
    registry.close(successor.id, { state: "done", resultPath: "/tmp/late.md", endedAt: Date.now() + 60_000 });
    host.settle();
    await flush();

    expect(host.newSessions).toHaveLength(1);
    expect(host.newSessions[0].seed?.text).toContain(
      `- ${successor.id} (explorer): done, result: /tmp/late.md`,
    );
    expect(host.newSessions[0].seed?.text).not.toContain(predecessor.id);
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
    expect(host.dispatched).toEqual([]);
    expect(status()).toContain("<error>");
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

    host.newSessionAccepted = false;
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

  it("does nothing while the context is unknown", () => {
    const { host, turn, status } = setup();

    turn(null);
    host.turnEnd({ tokens: 90_000, window: 0, percent: null });
    host.settle();

    expect(host.sent).toEqual([]);
    expect(host.dispatched).toEqual([]);
    expect(status()).toBeUndefined();
  });

  it("resets on session start", () => {
    const { host, turn, status } = setup();

    turn(76_000);
    host.start();

    expect(status()).toBeUndefined();

    turn(76_000);

    expect(host.sent).toHaveLength(2);
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
});
