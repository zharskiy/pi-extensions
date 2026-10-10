import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ChildEvent, ChildSession } from "../src/adapter/contract.ts";
import { createPiRuntime } from "../src/adapter/pi-adapter.ts";
import { sumOwnUsage, sumSessionUsage } from "../src/adapter/usage.ts";

const PROVIDER = "openai";
const MODEL = process.env.SPIKE_MODEL ?? "gpt-5.4-mini";
const root = resolve(process.argv[2] ?? join(process.cwd(), "scratch", "spike"));
const projectRoot = resolve(import.meta.dirname, "..");

mkdirSync(root, { recursive: true });

const log = (label: string, value: unknown) => {
  console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel(PROVIDER, MODEL);

if (!model) {
  throw new Error(`model ${PROVIDER}/${MODEL} not found`);
}

const fakeCtx = {
  model,
  modelRegistry: {
    find: (provider: string, id: string) => modelRuntime.getModel(provider, id),
    getAvailable: () => [model],
  },
  isProjectTrusted: () => false,
} as unknown as ExtensionContext;

const runtime = createPiRuntime({
  ctx: () => fakeCtx,
  settings: () => ({}),
  thinking: () => "low",
});

const settledOnce = (child: ChildSession) =>
  new Promise<void>((done) => {
    const off = child.subscribe((event: ChildEvent) => {
      if (event.type === "settled") {
        off();
        done();
      }
    });
  });

const assistantUsages = (file: string | undefined) => {
  if (!file) {
    return [];
  }

  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .map((entry) => ({
      input: entry.message.usage.input,
      cacheRead: entry.message.usage.cacheRead,
      output: entry.message.usage.output,
      cost: entry.message.usage.cost.total,
    }));
};

const partA = async () => {
  const started = Date.now();

  const children = await Promise.all(
    ["alpha", "beta", "gamma"].map((name) =>
      runtime.spawn({
        id: `spike-${name}`,
        cwd: projectRoot,
        sessionDir: join(root, "children", name),
        promptAppend: [readFileSync(join(projectRoot, "prompts", "base-system-prompt.md"), "utf8")],
        tools: ["read", "ls"],
        reserveTokens: 16_384,
      }),
    ),
  );

  log("A.spawned", { count: children.length, ms: Date.now() - started });

  const firstRuns = children.map((child) => settledOnce(child));

  children.forEach((child, index) => {
    child.start(
      `Use the ls tool on ${join(projectRoot, ["agents", "prompts", "src"][index])} and reply with only the number of entries.`,
    );
  });

  await new Promise((done) => setTimeout(done, 800));
  await Promise.all(
    children.map((child) =>
      child.send(
        { sender: "spike", text: "Also read the first file you list with the read tool before answering." },
        "steer",
      ),
    ),
  );
  await Promise.all(firstRuns);

  log("A.firstRun.ms", Date.now() - started);

  const secondRuns = children.map((child) => settledOnce(child));

  await Promise.all(
    children.map((child) =>
      child.send({ sender: "spike", text: "Now reply with the single word OK." }, "steer"),
    ),
  );
  await Promise.all(secondRuns);

  const report = children.map((child) => {
    const usages = assistantUsages(child.sessionFile);

    return {
      id: child.id,
      file: child.sessionFile,
      lastText: child.lastText(),
      context: child.context(),
      requests: usages.length,
      cacheReadByRequest: usages.map((usage) => usage.cacheRead),
      inputByRequest: usages.map((usage) => usage.input),
      cost: child.ownUsage().cost.total,
    };
  });

  report.forEach((entry) => {
    log(`A.child.${entry.id}`, entry);
  });

  const isolation = children.map((child, index) => {
    const text = readFileSync(child.sessionFile ?? "", "utf8");
    const others = ["agents", "prompts", "src"].filter((_, other) => other !== index);

    return { id: child.id, mentionsOwnDir: text.includes(["agents", "prompts", "src"][index]), others };
  });

  log("A.isolation", isolation);

  await Promise.all(children.map((child) => child.dispose()));

  log("A.disposed", true);

  return report.reduce((sum, entry) => sum + entry.cost, 0);
};

const partB = async () => {
  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: false } },
    { projectTrusted: false },
  );

  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: getAgentDir(),
    settingsManager,
    additionalExtensionPaths: [join(projectRoot, "src", "index.ts")],
  });

  await loader.reload();

  const extensionErrors = loader.getExtensions().errors;

  log("B.extensionErrors", extensionErrors);

  const sessionDir = join(root, "main");

  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: getAgentDir(),
    modelRuntime,
    model,
    thinkingLevel: "low",
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(projectRoot, sessionDir),
  });

  await session.bindExtensions({ mode: "print" });

  log("B.tools", session.getActiveToolNames());
  log("B.promptHasMainPrompt", session.systemPrompt.includes("Delegating to background agents"));

  const woken = new Promise<void>((done) => {
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "user") {
        const text = JSON.stringify(event.message.content);

        if (text.includes("[pi-subagents] Batch")) {
          done();
        }
      }
    });
  });

  await session.prompt(
    `Use run_agent to start exactly one "explorer" agent with the task: "List the files in ${join(projectRoot, "agents")} using ls and report their names." Then end your turn without doing anything else.`,
  );

  await session.waitForIdle();

  log("B.afterFirstTurn", "idle; waiting for batch wake");

  const timeout = new Promise<string>((done) => setTimeout(() => done("timeout"), 180_000));
  const outcome = await Promise.race([woken.then(() => "woken"), timeout]);

  log("B.wake", outcome);

  await new Promise((done) => setTimeout(done, 500));
  await session.waitForIdle();

  const usages = assistantUsages(session.sessionFile);

  log("B.main.requests", usages);

  const userMessages = session.messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content).slice(0, 200));

  log("B.main.userMessages", userMessages);
  log("B.main.lastText", session.getLastAssistantText());

  const mainUsage = sumSessionUsage(session.sessionManager.getEntries());
  const mainOwn = sumOwnUsage(session.sessionManager.getEntries());
  const stats = session.getSessionStats();

  log("B.main.costPi", stats.cost);
  log("B.main.costSumSession", mainUsage.cost.total);
  log("B.main.costOwn", mainOwn.cost.total);

  const runner = session.extensionRunner;

  if (runner?.hasHandlers("session_shutdown")) {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  }

  session.dispose();

  return stats.cost;
};

const partC = async () => {
  const settingsManager = SettingsManager.inMemory(
    { compaction: { enabled: false } },
    { projectTrusted: false },
  );
  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
  });

  await loader.reload();

  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: getAgentDir(),
    modelRuntime,
    model,
    thinkingLevel: "low",
    resourceLoader: loader,
    settingsManager,
    sessionManager: SessionManager.create(projectRoot, join(root, "plain")),
  });

  await session.bindExtensions({ mode: "print" });
  await session.prompt("Reply with the single word ONE.");
  await session.prompt("Reply with the single word TWO.");
  await new Promise((done) => setTimeout(done, 20_000));
  await session.prompt("Reply with the single word THREE.");

  log("C.plain.requests", assistantUsages(session.sessionFile));

  const cost = session.getSessionStats().cost;

  session.dispose();

  return cost;
};

const parts = (process.env.SPIKE_PARTS ?? "A,B").split(",");
const costs: Record<string, number> = {};

if (parts.includes("A")) {
  costs.A = await partA();
}

if (parts.includes("C")) {
  costs.C = await partC();
}

if (parts.includes("B")) {
  costs.B = await partB();
}

log("costs", costs);
writeFileSync(join(root, "costs.json"), JSON.stringify(costs, null, 2));
process.exit(0);
