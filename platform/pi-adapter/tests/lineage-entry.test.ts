import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import * as pi from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { initPiRenderTheme, plainPiTheme } from "../../../test/framework/pi/index.ts";
import { createPiHost } from "../runtime/host.ts";

initPiRenderTheme();

const temp = useTempDirs();

const SEED = { customType: "handoff-seed", text: "carry on from the handoff" };

const LINEAGE = "pi-adapter:lineage";

const LEGACY = "pi-adapter:previous-session";

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

    piHost.registerCommand("handoff", {
      description: "hand off",
      run: async (args, control) => {
        await control.newSession({
          parentSession: piHost.session().file,
          showPrevious: args === "show",
          seed: SEED,
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

  const draw = (entry: pi.CustomEntry | undefined, expanded = false) => {
    const renderer = entry && runtime.session.extensionRunner.getEntryRenderer(entry.customType);
    const component = entry && renderer?.(entry, { expanded }, plainPiTheme);

    return stripVTControlCharacters(component?.render(100).join("\n") ?? "");
  };

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

  it("draws the previous session's transcript under a boundary line", async () => {
    const session = await handOff("show");
    const drawn = session.draw(session.lineageEntry("handoff"));
    const boundary = drawn.indexOf("» previous session · ");

    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(drawn.indexOf("first question")).toBeGreaterThan(boundary);
    expect(drawn.indexOf("first answer")).toBeGreaterThan(drawn.indexOf("first question"));
    expect(drawn).not.toContain("second question");

    await session.runtime.dispose();
  });

  it("draws every session of a chain of handoffs, oldest first, with the handoff between them", async () => {
    const session = await handOff("show");

    await session.runtime.session.prompt("/handoff show");

    const drawn = session.draw(session.lineageEntry("handoff"));
    const order = ["first question", "first answer", SEED.text, "second question", "second answer"].map(
      (text) => drawn.indexOf(text),
    );

    expect(drawn.split("» previous session · ")).toHaveLength(3);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await session.runtime.dispose();
  });

  it("still draws an entry written under the earlier previous-session type", async () => {
    const session = await handOff("show");
    const written = session.lineageEntry("handoff") as pi.CustomEntry;
    const { file, leafId } = written.data as { file: string; leafId: string };
    const legacy = { ...written, customType: LEGACY, data: { file, leafId } };

    const drawn = session.draw(legacy as pi.CustomEntry);

    expect(drawn).toContain("» previous session · ");
    expect(drawn).toContain("first question");

    await session.runtime.dispose();
  });

  it("draws a not-found line when the previous session file is gone", async () => {
    const session = await startRuntime();
    const missing = "/nowhere/gone.jsonl";
    const entry = { type: "custom", customType: LINEAGE, data: { file: missing, leafId: null } };

    const drawn = session.draw({ ...entry, id: "e", parentId: null, timestamp: "" } as pi.CustomEntry);

    expect(drawn.trim()).toBe(`» previous session not found · ${missing}`);

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
    expect(collapsed).toMatch(/» 2 earlier messages, compacted/);
    expect(expanded).toContain("first question");
    expect(expanded).toContain("first answer");
    expect(expanded.indexOf("first answer")).toBeGreaterThan(expanded.indexOf("first question"));
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

    await session.runtime.session.compact();

    const latest = session.lineageEntries().at(-1);
    const expanded = session.draw(latest, true);
    const order = ["first question", "first answer", "second question", "second answer"].map((text) =>
      expanded.indexOf(text),
    );

    expect(session.draw(latest)).toMatch(/» 4 earlier messages, compacted/);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(expanded).not.toContain("third question");

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
      "» previous session · ",
      "first question",
      "first answer",
      "» 3 earlier messages, compacted",
      SEED.text,
      "second question",
      "second answer",
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

  it("labels the entry so /tree lists it under the labeled-only filter", async () => {
    const session = await compacted();

    expect(labeledTree(session.manager())).toContain(`[lineage: compaction] [custom: ${LINEAGE}]`);

    await session.runtime.dispose();
  });
});
