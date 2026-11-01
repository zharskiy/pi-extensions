import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { initPiRenderTheme, plainPiTheme } from "../../../test/framework/pi/index.ts";
import { createPiHost } from "../runtime/host.ts";
import { sharedPad } from "../tools/row-component.ts";

initPiRenderTheme();

const temp = useTempDirs();

const SEED = { customType: "handoff-seed", text: "carry on from the handoff" };

const LINEAGE = "pi-adapter:lineage";

const LEGACY = "pi-adapter:previous-session";

const NOTE = "test:note";

const KEPT = "test:kept";

const SEAM = /^\s*── .* ─+$/;

const TURNS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

type Order = string[];

type RuntimeOptions = { host?: boolean; piSummary?: boolean };

const startRuntime = async ({ host = true, piSummary = false }: RuntimeOptions = {}) => {
  const dir = temp.make("pi-lineage-");

  vi.stubEnv("PI_CODING_AGENT_DIR", dir);

  const faux = fauxProvider({ provider: "acme", models: [{ id: "small" }] });
  const modelRuntime = await pi.ModelRuntime.create();
  const requests: unknown[] = [];
  const order: Order = [];
  let keptPrompt: string | undefined;

  modelRuntime.registerNativeProvider(faux.provider);

  await modelRuntime.refresh({ allowNetwork: false });

  const reply = (text: string) => (context: unknown) => {
    requests.push(structuredClone(context));

    return fauxAssistantMessage(fauxText(text));
  };

  faux.setResponses(TURNS.map((turn) => reply(`${turn} answer`)));

  const settingsManager = pi.SettingsManager.inMemory({
    defaultProvider: "acme",
    defaultModel: "small",
    compaction: { keepRecentTokens: 1 },
  });

  const keepLastPrompt: pi.ExtensionFactory = (api) => {
    api.on("session_before_compact", (event) => {
      if (piSummary) {
        return undefined;
      }

      const kept = event.branchEntries.findLast(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          (keptPrompt === undefined || JSON.stringify(entry.message.content).includes(keptPrompt)),
      );

      return kept
        ? { compaction: { summary: "the summary", firstKeptEntryId: kept.id, tokensBefore: 100 } }
        : undefined;
    });

    api.on("session_compact", (event, ctx) => {
      const written = ctx.sessionManager.getEntries().some((entry) => entry.id === event.compactionEntry.id);

      order.push(written ? "session_compact after the compaction entry" : "session_compact before it");
    });
  };

  const handoff: pi.ExtensionFactory = (api) => {
    const piHost = createPiHost(api, { tools: new Map() });

    piHost.registerMessageRenderer(SEED.customType, (message) => [`seed: ${message.text}`]);
    piHost.registerEntryRenderer(NOTE, (data) => [`note: ${(data as { text: string }).text}`]);
    piHost.registerEntryRenderer(KEPT, (data) => [`kept: ${(data as { text: string }).text}`], {
      previousSession: false,
    });

    piHost.registerCommand("entries", {
      description: "append entries",
      run: async () => {
        piHost.appendEntry(NOTE, { text: "a drawn note" });
        piHost.appendEntry(KEPT, { text: "a kept message" });
      },
    });

    piHost.registerCommand("handoff", {
      description: "hand off",
      run: async (args, control) => {
        const shown = args.startsWith("as ") ? { label: args.slice(3) } : {};

        await control.newSession({
          parentSession: piHost.session().file,
          showPrevious: args === "" ? undefined : shown,
          fill: () => ({ seed: SEED }),
        });
      },
    });
  };

  const extensionFactories = [
    { name: "compaction", factory: keepLastPrompt },
    ...(host ? [{ name: "handoff", factory: handoff }] : []),
  ];

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
      resourceLoaderOptions: { extensionFactories },
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

    runtime.session.subscribe((event) => {
      if (event.type !== "compaction_end") {
        return;
      }

      const redrawn = runtime.session.sessionManager.buildContextEntries().slice(1);
      const marker = redrawn.some((entry) => entry.type === "custom" && entry.customType === LINEAGE);

      order.push(marker ? "compaction_end with the lineage entry in the redraw" : "compaction_end");
    });
  };

  runtime.setRebindSession(bind);
  await bind();

  const manager = () => runtime.session.sessionManager;

  const lineageEntries = () =>
    manager()
      .getEntries()
      .filter(
        (entry): entry is pi.CustomEntry =>
          entry.type === "custom" && (entry.customType === LINEAGE || entry.customType === LEGACY),
      );

  const lineageEntry = (reason: string) =>
    lineageEntries().find((entry) => (entry.data as { reason?: string }).reason === reason);

  const component = (entry: pi.CustomEntry | undefined, theme: pi.Theme, expanded = false) => {
    const renderer = entry && runtime.session.extensionRunner.getEntryRenderer(entry.customType);

    return entry && renderer?.(entry, { expanded }, theme);
  };

  const draw = (entry: pi.CustomEntry | undefined, expanded = false) =>
    stripVTControlCharacters(component(entry, plainPiTheme, expanded)?.render(100).join("\n") ?? "");

  const normalized = (request: unknown) =>
    JSON.parse(
      JSON.stringify(request, (key, value) =>
        ["timestamp", "api", "durationMs"].includes(key) ? undefined : value,
      ).replaceAll(dir, "<dir>"),
    );

  const keepFrom = (prompt: string) => {
    keptPrompt = prompt;
  };

  const compactionMarkers = (entries: readonly pi.SessionEntry[]) =>
    entries.filter(
      (entry): entry is pi.CustomEntry =>
        entry.type === "custom" &&
        entry.customType === LINEAGE &&
        (entry.data as { reason?: string }).reason === "compaction",
    );

  return {
    runtime,
    requests,
    order,
    dir,
    manager,
    lineageEntries,
    lineageEntry,
    component,
    draw,
    normalized,
    keepFrom,
    compactionMarkers,
  };
};

const handOff = async (args: string) => {
  const session = await startRuntime();

  await session.runtime.session.prompt("first question");
  await session.runtime.session.prompt(`/handoff ${args}`);
  await session.runtime.session.prompt("second question");

  return session;
};

const compacted = async (options: RuntimeOptions = {}) => {
  const session = await startRuntime(options);

  await session.runtime.session.prompt("first question");
  await session.runtime.session.prompt("second question");
  await session.runtime.session.compact();
  await session.runtime.session.prompt("third question");

  return session;
};

const labeledTree = (manager: pi.SessionManager) => {
  const selector = new pi.TreeSelectorComponent(
    manager.getTree(),
    manager.getLeafId(),
    40,
    () => {},
    () => {},
    undefined,
    undefined,
    "labeled-only",
  );

  return stripVTControlCharacters(selector.render(100).join("\n"));
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
    expect(shown.lineageEntry("handoff")).toBeDefined();
    expect(hidden.lineageEntries()).toEqual([]);

    await shown.runtime.dispose();
    await hidden.runtime.dispose();
  });

  it("keeps the model's requests the same on a later turn and after resuming the new session", async () => {
    const resumed = async (args: string) => {
      const session = await handOff(args);
      const file = session.manager().getSessionFile() ?? "";

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
    expect(shown.draw(shown.lineageEntry("handoff"))).toContain("first question");

    await shown.runtime.dispose();
    await hidden.runtime.dispose();
  });

  it("draws the previous session's transcript above a rule at the seam, a blank row on each side", async () => {
    const session = await handOff("show");
    const drawn = session.draw(session.lineageEntry("handoff"));
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

    expect(session.lineageEntry("handoff")?.data).toMatchObject({ label: "handed off · context limit" });
    expect(session.draw(session.lineageEntry("handoff"))).toContain("── handed off · context limit ─");

    await session.runtime.dispose();
  });

  it("draws every session of a chain of handoffs, oldest first, with the handoff between them", async () => {
    const session = await handOff("show");

    await session.runtime.session.prompt("/handoff as second seam");

    const drawn = session.draw(session.lineageEntry("handoff"));
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
    const manager = session.manager();
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

    const drawn = session.draw(session.lineageEntry("handoff"));
    const order = [
      "first question",
      "first answer",
      "── continued from previous session ─",
      "second question",
      "── compacted here ─",
      "[compaction]",
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

    const drawn = session.draw(session.lineageEntry("handoff"));
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
    const entry = session.lineageEntry("handoff");
    const line = (lines: string[] | undefined, text: string) =>
      lines?.find((row) => stripVTControlCharacters(row).includes(text));

    let skin = "dark";
    pi.initTheme("dark");
    const tagging = {
      ...plainPiTheme,
      fg: (token: string, text: string) => `<${skin}:${token}>${text}</>`,
    } as pi.Theme;

    const first = session.component(entry, tagging);
    const dark = first?.render(100);

    skin = "light";
    pi.initTheme("light");
    first?.invalidate();

    const light = session.component(entry, tagging)?.render(100);

    initPiRenderTheme();

    expect(line(dark, "first question")).toBeDefined();
    expect(line(light, "first question")).not.toBe(line(dark, "first question"));
    expect(line(dark, "continued from previous session")).toContain("<dark:dim>");
    expect(line(light, "continued from previous session")).toContain("<light:dim>");
    expect(line(light, "continued from previous session")).not.toContain("<dark:");

    await session.runtime.dispose();
  });

  it("draws the old session's custom entries with their renderers, except those kept out of it", async () => {
    const session = await startRuntime();

    await session.runtime.session.prompt("first question");
    await session.runtime.session.prompt("/entries");
    await session.runtime.session.prompt("/handoff show");

    const drawn = session.draw(session.lineageEntry("handoff"));

    expect(drawn).toContain(`${" ".repeat(sharedPad())}note: a drawn note`);
    expect(drawn.indexOf("note: a drawn note")).toBeGreaterThan(drawn.indexOf("first answer"));
    expect(drawn).not.toContain("kept: a kept message");

    await session.runtime.dispose();
  });

  it("draws the old session's compaction summary where the compaction sat in its history", async () => {
    const session = await startRuntime();

    await session.runtime.session.prompt("first question");

    const manager = session.manager();
    const question = manager
      .getEntries()
      .find((entry) => entry.type === "message" && entry.message.role === "user");

    manager.appendCompaction("the compacted summary", question?.id ?? null, 1234);

    await session.runtime.session.prompt("/handoff show");

    const drawn = session.draw(session.lineageEntry("handoff"));
    const order = ["first question", "first answer", "── compacted here ─", "[compaction]"].map((text) =>
      drawn.indexOf(text),
    );

    expect(drawn).toContain("Compacted from 1,234 tokens");
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await session.runtime.dispose();
  });

  it("draws the old session's bash executions with pi's own component", async () => {
    const session = await startRuntime();

    await session.runtime.session.prompt("first question");

    session.manager().appendMessage({
      role: "bashExecution",
      command: "echo from-the-shell",
      output: "from-the-shell",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    });

    await session.runtime.session.prompt("/handoff show");

    const drawn = session.draw(session.lineageEntry("handoff"));

    const rows = drawn.split("\n").map((row) => row.trim());

    expect(rows.indexOf("$ echo from-the-shell")).toBeGreaterThan(rows.indexOf("first answer"));
    expect(rows.indexOf("from-the-shell")).toBeGreaterThan(rows.indexOf("$ echo from-the-shell"));

    await session.runtime.dispose();
  });

  it("still draws an entry written under the earlier previous-session type", async () => {
    const session = await handOff("show");
    const written = session.lineageEntry("handoff") as pi.CustomEntry;
    const { file, leafId } = written.data as { file: string; leafId: string };
    const legacy = { ...written, customType: LEGACY, data: { file, leafId } };

    const drawn = session.draw(legacy as pi.CustomEntry);

    expect(drawn).toContain("── continued from previous session ─");
    expect(drawn).toContain("first question");

    await session.runtime.dispose();
  });

  it("draws a not-found rule when the previous session file is gone", async () => {
    const session = await startRuntime();
    const missing = "/nowhere/gone.jsonl";
    const entry = {
      type: "custom",
      customType: LINEAGE,
      data: { file: missing, leafId: null },
      id: "e",
      parentId: null,
      timestamp: "",
    } as pi.CustomEntry;

    const drawn = session.draw(entry);

    const tagging = {
      ...plainPiTheme,
      fg: (token: string, text: string) => `<${token}>${text}</>`,
    } as pi.Theme;
    const tagged = session.component(entry, tagging)?.render(100).join("\n");

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
          customType: LINEAGE,
          data: { file, leafId: "a", reason: "handoff" },
          id: "a",
          parentId: null,
          timestamp: at,
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );

    const entry = { type: "custom", customType: LINEAGE, data: { file, leafId: "a", reason: "handoff" } };
    const drawn = session.draw({ ...entry, id: "e", parentId: null, timestamp: "" } as pi.CustomEntry);
    const rules = drawn.split("\n").filter((row) => row.includes("── "));

    expect(rules.map((row) => row.trim().replace(/ ─+$/, ""))).toEqual([
      "── earlier sessions not shown",
      "── continued from previous session",
    ]);

    await session.runtime.dispose();
  });

  it("labels the entry so /tree lists it under the labeled-only filter", async () => {
    const session = await handOff("show");
    const entry = session.lineageEntry("handoff");

    expect(session.manager().getLabel(entry?.id ?? "")).toBe("lineage: handoff");
    expect(labeledTree(session.manager())).toContain(`[lineage: handoff] [custom: ${LINEAGE}]`);

    await session.runtime.dispose();
  });
});

describe("keeping the history a compaction drops", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gets session_compact after the compaction entry is written and before the chat is redrawn", async () => {
    const session = await compacted();

    expect(session.order).toEqual([
      "session_compact after the compaction entry",
      "compaction_end with the lineage entry in the redraw",
    ]);

    await session.runtime.dispose();
  });

  it("points the entry at the session's own file, up to the last entry the compaction dropped", async () => {
    const session = await compacted();
    const manager = session.manager();
    const compaction = manager.getEntries().find((entry) => entry.type === "compaction");
    const firstKept = manager.getEntry(compaction?.type === "compaction" ? compaction.firstKeptEntryId : "");

    expect(session.lineageEntry("compaction")?.data).toEqual({
      file: manager.getSessionFile(),
      leafId: firstKept?.parentId,
      reason: "compaction",
    });

    await session.runtime.dispose();
  });

  it("draws one marker line collapsed and the dropped messages expanded", async () => {
    const session = await compacted();
    const entry = session.lineageEntry("compaction");
    const collapsed = session.draw(entry);
    const expanded = session.draw(entry, true);

    expect(collapsed.trim().split("\n")).toHaveLength(1);
    expect(collapsed).toMatch(/── 2 earlier messages, compacted/);
    expect(expanded).toContain("first question");
    expect(expanded).toContain("first answer");
    expect(expanded.indexOf("first answer")).toBeGreaterThan(expanded.indexOf("first question"));
    expect(expanded.indexOf("── 2 earlier messages, compacted ─")).toBeGreaterThan(
      expanded.indexOf("first answer"),
    );
    expect(expanded).not.toContain("second question");

    await session.runtime.dispose();
  });

  it("is part of what pi draws after the compaction and after a resume", async () => {
    const session = await compacted();
    const file = session.manager().getSessionFile() ?? "";

    await session.runtime.newSession();
    await session.runtime.switchSession(file);

    const drawnOnResume = session
      .manager()
      .buildContextEntries()
      .filter((entry) => entry.type === "custom" && entry.customType === LINEAGE);

    expect(drawnOnResume).toHaveLength(1);
    expect(session.draw(drawnOnResume[0] as pi.CustomEntry, true)).toContain("first question");

    await session.runtime.dispose();
  });

  it("sends the model the same requests as a session without the entry, over two compactions", async () => {
    const recorded = await compacted();
    const plain = await compacted({ host: false });

    await recorded.runtime.session.compact();
    await plain.runtime.session.compact();
    await recorded.runtime.session.prompt("fourth question");
    await plain.runtime.session.prompt("fourth question");

    const requests = recorded.requests.slice(-2);

    expect(recorded.lineageEntries()).toHaveLength(2);
    expect(plain.lineageEntries()).toEqual([]);
    expect(requests.map(recorded.normalized)).toEqual(plain.requests.slice(-2).map(plain.normalized));
    expect(JSON.stringify(requests)).not.toContain("first question");

    await recorded.runtime.dispose();
    await plain.runtime.dispose();
  });

  it("leaves pi's own summary request the same as in a session without the entry", async () => {
    const recorded = await compacted({ piSummary: true });
    const plain = await compacted({ host: false, piSummary: true });

    await recorded.runtime.session.prompt("fourth question");
    await recorded.runtime.session.compact();
    await plain.runtime.session.prompt("fourth question");
    await plain.runtime.session.compact();

    expect(recorded.lineageEntries()).toHaveLength(2);
    expect(JSON.stringify(recorded.requests)).toContain("<conversation>");
    expect(recorded.requests.map(recorded.normalized)).toEqual(plain.requests.map(plain.normalized));

    await recorded.runtime.dispose();
    await plain.runtime.dispose();
  });

  it("draws everything before the latest compaction once the session compacts again", async () => {
    const session = await compacted();

    await session.runtime.session.prompt("fourth question");
    session.keepFrom("fourth question");
    await session.runtime.session.compact();

    const latest = session.lineageEntries().at(-1);
    const expanded = session.draw(latest, true);
    const order = [
      "first question",
      "first answer",
      "second question",
      "second answer",
      "── compacted here ─",
      "third question",
      "third answer",
    ].map((text) => expanded.indexOf(text));

    expect(session.draw(latest)).toMatch(/── 6 earlier messages, compacted/);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(expanded.split("── compacted here ─")).toHaveLength(2);
    expect(expanded).not.toContain("fourth question");

    await session.runtime.dispose();
  });

  it("draws each message of a fork's compacted history once", async () => {
    const session = await compacted();
    const original = session.manager().getSessionFile();
    const thirdAnswer = session
      .manager()
      .getEntries()
      .find((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("third answer"));

    await session.runtime.fork(thirdAnswer?.id ?? "", { position: "at" });
    await session.runtime.session.prompt("fourth question");
    session.keepFrom("fourth question");
    await session.runtime.session.compact();

    const latest = session.lineageEntries().at(-1);
    const expanded = session.draw(latest, true);
    const texts = ["first question", "first answer", "second question", "second answer", "third question"];

    expect(session.manager().getSessionFile()).not.toBe(original);
    expect(latest?.data).toMatchObject({ file: session.manager().getSessionFile(), reason: "compaction" });
    expect(session.draw(latest)).toMatch(/── 6 earlier messages, compacted/);
    expect(texts.map((text) => expanded.split(text).length - 1)).toEqual([1, 1, 1, 1, 1]);
    expect(expanded).not.toContain("continued from previous session");
    expect(expanded).not.toContain("fourth question");
    expect(session.draw(session.lineageEntries()[0], true)).toBe("");

    await session.runtime.dispose();
  });

  it("keeps a handed-off session's history in the marker once the new session compacts", async () => {
    const session = await handOff("show");

    await session.runtime.session.prompt("third question");
    await session.runtime.session.compact();

    const handoffDrawn = session
      .manager()
      .buildContextEntries()
      .some((entry) => entry.type === "custom" && (entry.data as { reason?: string }).reason === "handoff");

    const expanded = session.draw(session.lineageEntry("compaction"), true);

    const order = [
      "first question",
      "first answer",
      "── continued from previous session ─",
      SEED.text,
      "second question",
      "second answer",
      "── 5 earlier messages, compacted ─",
    ].map((text) => expanded.indexOf(text));

    expect(handoffDrawn).toBe(false);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(expanded).not.toContain("third question");

    await session.runtime.dispose();
  });

  it("records the compaction on another branch that drops the same entries", async () => {
    const session = await compacted();
    const firstLeaf = session.lineageEntry("compaction")?.data;
    const secondAnswer = session
      .manager()
      .getEntries()
      .find((entry) => entry.type === "message" && JSON.stringify(entry.message).includes("second answer"));

    await session.runtime.session.navigateTree(secondAnswer?.id ?? "", { summarize: false });
    await session.runtime.session.prompt("fourth question");
    session.keepFrom("second question");
    await session.runtime.session.compact();

    const onBranch = session.compactionMarkers(session.manager().getBranch());

    expect(onBranch).toHaveLength(1);
    expect(onBranch[0]?.data).toEqual(firstLeaf);
    expect(session.draw(onBranch[0], true)).toContain("first question");

    await session.runtime.dispose();
  });

  it("draws only the latest marker when a later compaction keeps an earlier marker", async () => {
    const session = await startRuntime();

    await session.runtime.session.prompt("first question");
    await session.runtime.session.prompt("second question");
    await session.runtime.session.prompt("third question");
    session.keepFrom("second question");
    await session.runtime.session.compact();
    await session.runtime.session.prompt("fourth question");
    session.keepFrom("third question");
    await session.runtime.session.compact();

    const markers = session.compactionMarkers(session.manager().buildContextEntries());
    const drawn = markers.map((marker) => session.draw(marker, true));
    const shown = drawn.filter((text) => text !== "");

    expect(markers).toHaveLength(2);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.split("first question")).toHaveLength(2);
    expect(shown[0]).toContain("second answer");

    await session.runtime.dispose();
  });

  it("labels the entry so /tree lists it under the labeled-only filter", async () => {
    const session = await compacted();

    expect(labeledTree(session.manager())).toContain(`[lineage: compaction] [custom: ${LINEAGE}]`);

    await session.runtime.dispose();
  });
});
