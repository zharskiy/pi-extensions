import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { initPiRenderTheme, livePiTheme, plainPiTheme } from "../../../test/framework/pi/index.ts";
import { createPiHost } from "../runtime/host.ts";
import { sharedPad } from "../tools/row-component.ts";

initPiRenderTheme();

const temp = useTempDirs();

const SEED = { customType: "handoff-seed", text: "carry on from the handoff" };

const PREVIOUS = "pi-adapter:previous-session";

const NOTE = "test:note";

const KEPT = "test:kept";

const SEAM = /^\s*── .* ─+$/;

const startRuntime = async () => {
  const dir = temp.make("pi-previous-session-");

  vi.stubEnv("PI_CODING_AGENT_DIR", dir);

  const faux = fauxProvider({ provider: "acme", models: [{ id: "small" }] });
  const modelRuntime = await pi.ModelRuntime.create();
  const requests: unknown[] = [];

  modelRuntime.registerNativeProvider(faux.provider);

  const reply = (text: string) => (context: unknown) => {
    requests.push(structuredClone(context));

    return fauxAssistantMessage(fauxText(text));
  };

  faux.setResponses(
    ["first", "second", "third", "fourth", "fifth", "sixth", "seventh"].map((turn) =>
      reply(`${turn} answer`),
    ),
  );

  const settingsManager = pi.SettingsManager.inMemory({ defaultProvider: "acme", defaultModel: "small" });

  const handoff: pi.ExtensionFactory = (api) => {
    const host = createPiHost(api, { tools: new Map() });

    host.registerMessageRenderer(SEED.customType, (message) => [`seed: ${message.text}`]);
    host.registerEntryRenderer(NOTE, (data) => [`note: ${(data as { text: string }).text}`]);
    host.registerEntryRenderer(KEPT, (data) => [`kept: ${(data as { text: string }).text}`], {
      previousSession: false,
    });

    host.registerCommand("entries", {
      description: "append entries",
      run: async () => {
        host.appendEntry(NOTE, { text: "a drawn note" });
        host.appendEntry(KEPT, { text: "a kept message" });
      },
    });

    host.registerCommand("handoff", {
      description: "hand off",
      run: async (args, control) => {
        const shown = args.startsWith("as ") ? { label: args.slice(3) } : {};

        await control.newSession({
          parentSession: host.session().file,
          showPrevious: args === "" ? undefined : shown,
          fill: () => ({ seed: SEED }),
        });
      },
    });
  };

  const createRuntime: pi.CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: { extensionFactories: [{ name: "handoff", factory: handoff }] },
    });
    const created = await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });

    return { ...created, services, diagnostics: services.diagnostics };
  };

  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: dir,
    agentDir: dir,
    sessionManager: pi.SessionManager.create(dir, dir),
  });

  const bind = async () => {
    await runtime.session.bindExtensions({
      mode: "print",
      uiContext: { notify: () => {} } as unknown as pi.ExtensionUIContext,
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => runtime.newSession(options),
        fork: (entryId, options) => runtime.fork(entryId, options),
        navigateTree: async () => ({ cancelled: true }),
        switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
        reload: async () => {},
      },
    });
  };

  runtime.setRebindSession(bind);
  await bind();

  const previousEntry = () =>
    runtime.session.sessionManager
      .getEntries()
      .find((entry): entry is pi.CustomEntry => entry.type === "custom" && entry.customType === PREVIOUS);

  const component = (entry: pi.CustomEntry | undefined, theme: pi.Theme) => {
    const renderer = runtime.session.extensionRunner.getEntryRenderer(PREVIOUS);

    return entry && renderer?.(entry, { expanded: false }, theme);
  };

  const draw = (entry: pi.CustomEntry | undefined) => {
    const drawn = component(entry, plainPiTheme);

    return stripVTControlCharacters(drawn?.render(100).join("\n") ?? "");
  };

  const normalized = (request: unknown) =>
    JSON.parse(
      JSON.stringify(request, (key, value) =>
        ["timestamp", "api"].includes(key) ? undefined : value,
      ).replaceAll(dir, "<dir>"),
    );

  return { runtime, requests, dir, previousEntry, component, draw, normalized };
};

const handOff = async (args: string) => {
  const session = await startRuntime();

  await session.runtime.session.prompt("first question");
  await session.runtime.session.prompt(`/handoff ${args}`);
  await session.runtime.session.prompt("second question");

  return session;
};

describe("showing the previous session after a handoff", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the model exactly what it gets without the previous session shown", async () => {
    const shown = await handOff("show");
    const hidden = await handOff("");
    const request = shown.requests.at(-1);

    expect(shown.requests).toHaveLength(2);
    expect(shown.normalized(request)).toEqual(hidden.normalized(hidden.requests.at(-1)));
    expect(JSON.stringify(request)).toContain(SEED.text);
    expect(JSON.stringify(request)).toContain("second question");
    expect(JSON.stringify(request)).not.toContain("first question");
    expect(JSON.stringify(request)).not.toContain("first answer");
    expect(shown.previousEntry()).toBeDefined();
    expect(hidden.previousEntry()).toBeUndefined();

    await shown.runtime.dispose();
    await hidden.runtime.dispose();
  });

  it("keeps the model's requests the same on a later turn and after resuming the new session", async () => {
    const resumed = async (args: string) => {
      const session = await handOff(args);
      const file = session.runtime.session.sessionManager.getSessionFile() ?? "";

      await session.runtime.session.prompt("third question");
      await session.runtime.newSession();
      await session.runtime.switchSession(file);
      await session.runtime.session.prompt("fourth question");

      return session;
    };

    const shown = await resumed("show");
    const hidden = await resumed("");
    const requests = shown.requests.slice(-2);

    expect(shown.requests).toHaveLength(4);
    expect(requests.map(shown.normalized)).toEqual(hidden.requests.slice(-2).map(hidden.normalized));
    expect(JSON.stringify(requests.at(-1))).toContain("third answer");
    expect(JSON.stringify(requests)).toContain("fourth question");
    expect(JSON.stringify(requests)).not.toContain("first question");
    expect(JSON.stringify(requests)).not.toContain("first answer");
    expect(shown.draw(shown.previousEntry())).toContain("first question");

    await shown.runtime.dispose();
    await hidden.runtime.dispose();
  });

  it("draws the previous session's transcript above a rule at the seam, a blank row on each side", async () => {
    const session = await handOff("show");
    const drawn = session.draw(session.previousEntry());
    const seed = new pi.CustomMessageComponent(
      { role: "custom", customType: SEED.customType, content: SEED.text, display: true, timestamp: 0 },
      session.runtime.session.extensionRunner.getMessageRenderer(SEED.customType),
    ).render(100);
    const rows = [...drawn.split("\n"), ...seed.map((row) => stripVTControlCharacters(row))];
    const seam = rows.findIndex((row) => row.includes("── continued from previous session ─"));
    const blank = (row: string | undefined) => row === "";

    expect(drawn.indexOf("first question")).toBeGreaterThanOrEqual(0);
    expect(drawn.indexOf("first answer")).toBeGreaterThan(drawn.indexOf("first question"));
    expect(seam).toBe(drawn.split("\n").length - 1);
    expect(rows[seam]?.trimEnd().endsWith("─")).toBe(true);
    expect(rows[seam]?.length).toBe(100);
    expect([rows[seam - 2], rows[seam - 1], rows[seam + 1], rows[seam + 2]].map(blank)).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(rows[seam + 2]?.trim()).toBe(`seed: ${SEED.text}`);
    expect(drawn).not.toContain(session.dir);
    expect(drawn).not.toContain("second question");

    await session.runtime.dispose();
  });

  it("draws the label the caller passed in the rule", async () => {
    const session = await handOff("as handed off · context limit");

    expect(session.draw(session.previousEntry())).toContain("── handed off · context limit ─");

    await session.runtime.dispose();
  });

  it("draws every session of a chain of handoffs, oldest first, with the handoff between them", async () => {
    const session = await handOff("show");

    await session.runtime.session.prompt("/handoff as second seam");

    const drawn = session.draw(session.previousEntry());
    const order = [
      "first question",
      "first answer",
      "── continued from previous session ─",
      SEED.text,
      "second question",
      "second answer",
      "── second seam ─",
    ].map((text) => drawn.indexOf(text));

    expect(drawn.split("\n").filter((row) => SEAM.test(row))).toHaveLength(2);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await session.runtime.dispose();
  });

  it("follows the chain through a link that was compacted after its handoff", async () => {
    const session = await handOff("show");
    const manager = session.runtime.session.sessionManager;
    const question = manager
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          JSON.stringify(entry).includes("second question"),
      );

    manager.appendCompaction("the middle summary", question?.id ?? null, 1234);

    await session.runtime.session.prompt("/handoff as second seam");

    const drawn = session.draw(session.previousEntry());
    const order = [
      "first question",
      "first answer",
      "── continued from previous session ─",
      "[compaction]",
      "second question",
      "── second seam ─",
    ].map((text) => drawn.indexOf(text));

    expect(drawn).not.toContain("earlier sessions not shown");
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await session.runtime.dispose();
  });

  it("stops a chain longer than the limit with one rule above the sessions it draws", async () => {
    const session = await handOff("show");

    await ["2", "3", "4", "5", "6"].reduce(async (done, seam) => {
      await done;
      await session.runtime.session.prompt(`/handoff as seam ${seam}`);
      await session.runtime.session.prompt(`question after seam ${seam}`);
    }, Promise.resolve());

    const drawn = session.draw(session.previousEntry());
    const rules = drawn
      .split("\n")
      .filter((row) => SEAM.test(row))
      .map((row) => row.trim().replace(/ ─+$/, ""));

    expect(rules).toEqual([
      "── earlier sessions not shown",
      "── seam 2",
      "── seam 3",
      "── seam 4",
      "── seam 5",
      "── seam 6",
    ]);
    expect(drawn).not.toContain("first question");

    await session.runtime.dispose();
  });

  it("redraws the previous session in the new theme once pi invalidates the entry", async () => {
    const session = await handOff("show");
    const entry = session.previousEntry();
    const line = (lines: string[] | undefined, text: string) =>
      lines?.find((row) => stripVTControlCharacters(row).includes(text));

    pi.initTheme("dark");

    const first = session.component(entry, livePiTheme);
    const dark = first?.render(100);

    pi.initTheme("light");
    first?.invalidate();

    const light = session.component(entry, livePiTheme)?.render(100);

    initPiRenderTheme();

    expect(line(dark, "first question")).toBeDefined();
    expect(line(light, "first question")).not.toBe(line(dark, "first question"));
    expect(line(light, "continued from previous session")).not.toBe(
      line(dark, "continued from previous session"),
    );

    await session.runtime.dispose();
  });

  it("draws the old session's custom entries with their renderers, except those kept out of it", async () => {
    const session = await startRuntime();

    await session.runtime.session.prompt("first question");
    await session.runtime.session.prompt("/entries");
    await session.runtime.session.prompt("/handoff show");

    const drawn = session.draw(session.previousEntry());

    expect(drawn).toContain(`${" ".repeat(sharedPad())}note: a drawn note`);
    expect(drawn.indexOf("note: a drawn note")).toBeGreaterThan(drawn.indexOf("first answer"));
    expect(drawn).not.toContain("kept: a kept message");

    await session.runtime.dispose();
  });

  it("draws the old session's compaction summary at the top of its transcript", async () => {
    const session = await startRuntime();

    await session.runtime.session.prompt("first question");

    const manager = session.runtime.session.sessionManager;
    const question = manager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");

    manager.appendCompaction("the compacted summary", question?.id ?? null, 1234);

    await session.runtime.session.prompt("/handoff show");

    const drawn = session.draw(session.previousEntry());
    const summary = drawn.indexOf("[compaction]");
    const first = drawn.split("\n").find((row) => row.trim() !== "");

    expect(first?.trim()).toBe("[compaction]");
    expect(drawn).toContain("Compacted from 1,234 tokens");
    expect(drawn.indexOf("first question")).toBeGreaterThan(summary);

    await session.runtime.dispose();
  });

  it("draws the old session's bash executions with pi's own component", async () => {
    const session = await startRuntime();

    await session.runtime.session.prompt("first question");

    session.runtime.session.sessionManager.appendMessage({
      role: "bashExecution",
      command: "echo from-the-shell",
      output: "from-the-shell",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    });

    await session.runtime.session.prompt("/handoff show");

    const drawn = session.draw(session.previousEntry());

    const rows = drawn.split("\n").map((row) => row.trim());

    expect(rows.indexOf("$ echo from-the-shell")).toBeGreaterThan(rows.indexOf("first answer"));
    expect(rows.indexOf("from-the-shell")).toBeGreaterThan(rows.indexOf("$ echo from-the-shell"));

    await session.runtime.dispose();
  });

  it("draws a not-found line when the previous session file is gone", async () => {
    const session = await startRuntime();
    const missing = "/nowhere/gone.jsonl";
    const entry = { type: "custom", customType: PREVIOUS, data: { file: missing, leafId: null } };

    const drawn = session.draw({ ...entry, id: "e", parentId: null, timestamp: "" } as pi.CustomEntry);

    const tagging = {
      ...plainPiTheme,
      fg: (token: string, text: string) => `<${token}>${text}</>`,
    } as pi.Theme;
    const tagged = session
      .component({ ...entry, id: "e", parentId: null, timestamp: "" } as pi.CustomEntry, tagging)
      ?.render(100)
      .join("\n");

    expect(drawn.trim()).toMatch(/^── previous session not found ─+$/);
    expect(tagged?.trim()).toMatch(/^<warning>── previous session not found ─/);
    expect(drawn).not.toContain(missing);

    await session.runtime.dispose();
  });

  it("draws a rule instead of sessions it already drew", async () => {
    const session = await startRuntime();
    const file = join(session.dir, "looped.jsonl");
    const at = "2026-01-01T00:00:00.000Z";

    writeFileSync(
      file,
      [
        { type: "session", version: 3, id: "looped", timestamp: at, cwd: session.dir },
        {
          type: "custom",
          customType: PREVIOUS,
          data: { file, leafId: "a" },
          id: "a",
          parentId: null,
          timestamp: at,
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const entry = { type: "custom", customType: PREVIOUS, data: { file, leafId: "a" } };
    const drawn = session.draw({ ...entry, id: "e", parentId: null, timestamp: "" } as pi.CustomEntry);
    const rules = drawn.split("\n").filter((row) => row.includes("── "));

    expect(rules.map((row) => row.trim().replace(/ ─+$/, ""))).toEqual([
      "── earlier sessions not shown",
      "── continued from previous session",
    ]);

    await session.runtime.dispose();
  });
});
