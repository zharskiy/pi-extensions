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

const PREVIOUS = "pi-adapter:previous-session";

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

  faux.setResponses(["first", "second", "third", "fourth"].map((turn) => reply(`${turn} answer`)));

  const settingsManager = pi.SettingsManager.inMemory({ defaultProvider: "acme", defaultModel: "small" });

  const handoff: pi.ExtensionFactory = (api) => {
    const host = createPiHost(api, { tools: new Map() });

    host.registerCommand("handoff", {
      description: "hand off",
      run: async (args, control) => {
        await control.newSession({
          parentSession: host.session().file,
          showPrevious: args === "show",
          seed: SEED,
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

  const draw = (entry: pi.CustomEntry | undefined) => {
    const renderer = runtime.session.extensionRunner.getEntryRenderer(PREVIOUS);
    const component = entry && renderer?.(entry, { expanded: false }, plainPiTheme);

    return stripVTControlCharacters(component?.render(100).join("\n") ?? "");
  };

  const normalized = (request: unknown) =>
    JSON.parse(
      JSON.stringify(request, (key, value) =>
        ["timestamp", "api"].includes(key) ? undefined : value,
      ).replaceAll(dir, "<dir>"),
    );

  return { runtime, requests, dir, previousEntry, draw, normalized };
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

  it("draws the previous session's transcript under a boundary line", async () => {
    const session = await handOff("show");
    const drawn = session.draw(session.previousEntry());
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

    const drawn = session.draw(session.previousEntry());
    const order = ["first question", "first answer", SEED.text, "second question", "second answer"].map(
      (text) => drawn.indexOf(text),
    );

    expect(drawn.split("» previous session · ")).toHaveLength(3);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    await session.runtime.dispose();
  });

  it("draws a not-found line when the previous session file is gone", async () => {
    const session = await startRuntime();
    const missing = "/nowhere/gone.jsonl";
    const entry = { type: "custom", customType: PREVIOUS, data: { file: missing, leafId: null } };

    const drawn = session.draw({ ...entry, id: "e", parentId: null, timestamp: "" } as pi.CustomEntry);

    expect(drawn.trim()).toBe(`» previous session not found · ${missing}`);

    await session.runtime.dispose();
  });
});
