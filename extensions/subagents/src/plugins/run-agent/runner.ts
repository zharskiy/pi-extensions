import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AgentRuntime,
  type AnyToolSpec,
  type ChildEvent,
  type ChildPrompts,
  type ChildSession,
  type RoutedMessage,
  type SessionInfo,
  type StopReason,
  splitModelRequest,
} from "../../../../../core/adapter/contract.ts";
import type { Bus } from "../../model/events.ts";
import { agentsDirFor } from "../../model/paths.ts";
import type { Settings } from "../../model/settings.ts";
import {
  type AgentDefinition,
  type AgentDefinitions,
  type AgentRecord,
  type AgentRegistry,
  type AgentRunner,
  chainTerminal,
  type HandoffService,
  isClosed,
  MAIN_CALLER,
  type RouteResult,
} from "../../model/types.ts";
import { resolutionError } from "./model-text.ts";
import { createOutbox, type Outbox } from "./outbox.ts";
import { batchMessage, RESULT_FILE, storeResult } from "./result.ts";
import { createSemaphore } from "./semaphore.ts";

export type BatchItem = {
  agent: string;
  task: string;
  files?: string[];
  description?: string;
  model?: string;
};

export type ModelPlan = { model: string; thinking: string; label: string };

export type StartedBatch = { batchId: string; records: AgentRecord[]; settled: Promise<AgentRecord[]> };

export type RunnerDeps = {
  registry: AgentRegistry;
  runtime: AgentRuntime;
  bus: Bus;
  settings: Settings;
  definitions: AgentDefinitions;
  outbox: Outbox;
  session: () => SessionInfo | undefined;
  handoff: () => HandoffService | undefined;
  toolsFor?: (record: AgentRecord) => AnyToolSpec[];
  promptsFor?: (record: AgentRecord) => ChildPrompts;
  now?: () => number;
};

export type Runner = AgentRunner & {
  startBatch(
    items: BatchItem[],
    options: { callerId: string; callerDepth: number; wait: boolean },
  ): StartedBatch;
  batchText(batchId: string): string;
  stop(id: string, options?: { immediate?: boolean }): Promise<boolean>;
  shutdown(reason: string): Promise<void>;
  live(id: string): ChildSession | undefined;
};

type Batch = {
  id: string;
  ids: string[];
  callerId: string;
  wait: boolean;
  woken: boolean;
  resolve: (records: AgentRecord[]) => void;
};

type LaunchSlot = { item: BatchItem; plan: ModelPlan };

type Live = {
  child?: ChildSession;
  lastStopReason?: StopReason;
  lastToolCalls: number;
  lastError?: string;
  abortReason?: string;
  lastText: string;
  pending: RoutedMessage[];
  unsubscribe?: () => void;
  release?: () => void;
  graceTimer?: ReturnType<typeof setTimeout>;
  answering: boolean;
  inFlight: boolean;
  outbox?: Outbox;
  idleHandlers: (() => void)[];
};

const FAILED_STOP_REASONS: ReadonlySet<StopReason> = new Set(["error", "aborted"]);

export const newBatchId = () => `b-${randomBytes(3).toString("hex")}`;

export const composeTask = (
  record: AgentRecord,
  item: BatchItem,
  outputToFile: boolean,
  predecessor?: AgentRecord,
) => {
  const files = predecessor ? [predecessor.handoffPath].concat(item.files ?? []) : (item.files ?? []);
  const lines = [`Task from ${record.callerId} (agent id ${record.id}):`];

  if (predecessor) {
    lines.push(
      `You continue the work of agent ${predecessor.id} as link ${record.chainIndex} of its chain; it reached its context budget and wrote a handoff file.`,
      `Read the handoff file at ${predecessor.handoffPath} first, then carry on from its Next section without redoing the work it reports as done.`,
      "",
      "Original task:",
    );
  }

  lines.push(item.task);

  if (files.length > 0) {
    lines.push("", "Input files:");

    files.forEach((file) => {
      lines.push(`- ${file}`);
    });
  }

  if (outputToFile) {
    lines.push("", `Result file: ${join(record.dir, RESULT_FILE)}`);
  }

  return lines.join("\n");
};

const readText = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

export const createRunner = (deps: RunnerDeps): Runner => {
  const now = deps.now ?? Date.now;
  const semaphore = createSemaphore(() => deps.settings.maxConcurrent);
  const batches = new Map<string, Batch>();
  const lives = new Map<string, Live>();
  const fileOutputs = new Set<string>();
  const launches = new Map<string, LaunchSlot>();
  const userStopped = new Set<string>();
  let shuttingDown = false;

  const liveOf = (id: string) => {
    const existing = lives.get(id);

    if (existing) {
      return existing;
    }

    const created: Live = {
      lastText: "",
      lastToolCalls: 0,
      pending: [],
      answering: false,
      inFlight: false,
      idleHandlers: [],
    };

    lives.set(id, created);

    return created;
  };

  const batchText = (batchId: string) => {
    const records = deps.registry.batch(batchId);

    return batchMessage(batchId, records, deps.settings.inlineResultChars, fileOutputs, now());
  };

  const checkBatch = (record: AgentRecord) => {
    const batch = batches.get(record.batchId);

    if (!batch || batch.woken || shuttingDown) {
      return;
    }

    const records = batch.ids.map((id) => deps.registry.get(id)).filter((entry) => entry !== undefined);
    const allClosed = records.every((entry) => isClosed(entry.state));

    if (!allClosed) {
      return;
    }

    batch.woken = true;
    batch.resolve(records.filter((entry) => !entry.successorId));

    if (batch.wait) {
      return;
    }

    callerOutbox(batch.callerId)?.post(batchText(batch.id));
  };

  const stopChildrenOf = (record: AgentRecord) => {
    deps.registry
      .list()
      .filter((child) => child.callerId === record.id && !isClosed(child.state))
      .forEach((child) => {
        void stop(child.id, { immediate: true });
      });
  };

  deps.bus.on("agent:closed", (record) => {
    checkBatch(record);
    stopChildrenOf(record);
  });

  const hasOpenBatches = (callerId: string) =>
    Array.from(batches.values()).some((batch) => batch.callerId === callerId && !batch.woken && !batch.wait);

  const resume = async (id: string, deliver: (child: ChildSession) => Promise<void>) => {
    const live = lives.get(id);

    if (!live?.child) {
      return;
    }

    live.inFlight = true;

    const release = await semaphore.acquire();
    const record = deps.registry.get(id);
    const child = live.child;

    if (!record || isClosed(record.state) || shuttingDown || !child) {
      release();
      live.inFlight = false;
      return;
    }

    live.release = release;

    await deliver(child).catch(async (error: unknown) => {
      deps.registry.close(id, { state: "failed", error: `wake failed: ${(error as Error).message}` });
      await releaseLive(id);
    });
  };

  const callerOutbox = (callerId: string): Outbox | undefined => {
    if (callerId === MAIN_CALLER) {
      return deps.outbox;
    }

    const record = deps.registry.get(callerId);
    const live = lives.get(callerId);

    if (!record || isClosed(record.state) || !live) {
      return undefined;
    }

    live.outbox ??= createOutbox({
      isBusy: () => live.inFlight,
      deliver: (text) => {
        void resume(callerId, (child) => child.wake(text));
      },
      onIdle: (handler) => {
        live.idleHandlers.push(handler);
      },
    });

    return live.outbox;
  };

  const releaseSlot = (live: Live) => {
    live.release?.();
    live.release = undefined;
  };

  const goIdle = (live: Live) => {
    releaseSlot(live);

    live.idleHandlers.forEach((handler) => {
      handler();
    });
  };

  const releaseLive = async (id: string) => {
    const live = lives.get(id);

    if (!live) {
      return;
    }

    live.unsubscribe?.();
    live.inFlight = false;
    live.outbox?.clear();
    releaseSlot(live);

    const child = live.child;

    live.child = undefined;

    if (child) {
      deps.bus.emit("agent:usage", { id, usage: child.ownUsage() });
      await child.dispose().catch(() => undefined);
    }
  };

  const finishHandoff = (record: AgentRecord) => {
    const text = readText(record.handoffPath);

    if (text === undefined) {
      return deps.registry.close(record.id, {
        state: "failed",
        error: `context budget reached but no handoff file was written at ${record.handoffPath}`,
      });
    }

    const validation = deps.handoff()?.validate(text) ?? { ok: true as const, status: "unknown" };

    if (!validation.ok) {
      return deps.registry.close(record.id, {
        state: "handoff",
        resultText: text,
        error: validation.errors.join("; "),
      });
    }

    const slot = launches.get(record.id);
    const batch = batches.get(record.batchId);

    if (validation.status === "partial" && slot && batch && canContinue(record, batch)) {
      return continueChain(record, text, slot, batch);
    }

    return deps.registry.close(record.id, { state: "handoff", resultText: text });
  };

  const canContinue = (record: AgentRecord, batch: Batch) =>
    record.chainIndex < deps.settings.maxChainLength &&
    record.state !== "grace" &&
    !userStopped.has(record.id) &&
    !shuttingDown &&
    !batch.woken;

  const continueChain = (record: AgentRecord, text: string, slot: LaunchSlot, batch: Batch) => {
    const successor = deps.registry.create({
      agent: record.agent,
      task: record.task,
      description: record.description,
      callerId: record.callerId,
      depth: record.depth,
      batchId: record.batchId,
      dir: dirname(record.dir),
      budgetTokens: record.budgetTokens,
      model: record.model,
      chainIndex: record.chainIndex + 1,
      predecessorId: record.id,
    });

    launches.set(successor.id, slot);

    if (fileOutputs.has(record.id)) {
      fileOutputs.add(successor.id);
    }

    batch.ids.push(successor.id);

    const closed = deps.registry.close(record.id, {
      state: "handoff",
      resultText: text,
      successorId: successor.id,
    });

    void launch(successor, slot.item, slot.plan);

    return closed;
  };

  const finish = (record: AgentRecord, live: Live, aborted: boolean) => {
    if (isClosed(record.state)) {
      return;
    }

    if (record.handoffRequested) {
      finishHandoff(record);
      return;
    }

    const text = (live.child?.lastText() || live.lastText).trim();
    const failedStop = live.lastStopReason !== undefined && FAILED_STOP_REASONS.has(live.lastStopReason);

    if (aborted || failedStop) {
      deps.registry.close(record.id, {
        state: "failed",
        error:
          live.abortReason ?? live.lastError ?? (aborted ? "aborted" : `stopped with ${live.lastStopReason}`),
      });

      return;
    }

    if (text.length === 0) {
      deps.registry.close(record.id, { state: "failed", error: "agent finished with an empty result" });
      return;
    }

    const stored = fileOutputs.has(record.id) ? readText(join(record.dir, RESULT_FILE)) : undefined;
    const result = storeResult(record, stored ?? text);

    deps.registry.close(record.id, { state: "done", ...result });
  };

  const clearGrace = (live: Live | undefined) => {
    if (live?.graceTimer) {
      clearTimeout(live.graceTimer);
    }

    if (live) {
      live.graceTimer = undefined;
    }
  };

  const closeStopped = (record: AgentRecord, error: string) => {
    const live = lives.get(record.id);

    clearGrace(live);

    const text = (live?.child?.lastText() || live?.lastText || "").trim();
    const result = text.length > 0 ? storeResult(record, text) : {};

    deps.registry.close(record.id, { state: "stopped", error, graceEndsAt: undefined, ...result });
  };

  const expireGrace = async (id: string) => {
    const record = deps.registry.get(id);

    if (record?.state !== "grace") {
      return;
    }

    closeStopped(record, "stopped by the user");
    await releaseLive(id);
  };

  const armGrace = (id: string, live: Live) => {
    clearGrace(live);

    const graceMs = deps.settings.stopGraceSeconds * 1_000;

    deps.registry.update(id, { graceEndsAt: now() + graceMs });
    live.graceTimer = setTimeout(() => void expireGrace(id), graceMs);
  };

  const settleGrace = (record: AgentRecord, live: Live) => {
    live.answering = false;

    const handoffWritten = record.handoffRequested && existsSync(record.handoffPath);

    if (live.abortReason === undefined && !handoffWritten) {
      armGrace(record.id, live);
      return;
    }

    clearGrace(live);
    deps.registry.update(record.id, { graceEndsAt: undefined });
    finish(record, live, live.abortReason !== undefined);
    void releaseLive(record.id);
  };

  const handleEvent = (id: string, live: Live, event: ChildEvent) => {
    const record = deps.registry.get(id);

    if (!record) {
      return;
    }

    if (event.type === "turn_end") {
      const usage = live.child?.ownUsage();
      const tokens = usage ? usage.input + usage.output + usage.cacheWrite : record.tokens;
      const turns = record.turns + 1;

      deps.registry.update(id, { turns, context: event.context, tokens, lastText: live.lastText });

      if (usage) {
        deps.bus.emit("agent:usage", { id, usage });
      }

      const continuing =
        live.lastToolCalls > 0 &&
        live.lastStopReason !== undefined &&
        !FAILED_STOP_REASONS.has(live.lastStopReason);

      deps.bus.emit("agent:turn", { id, context: event.context, turns, continuing });

      return;
    }

    if (event.type === "assistant_message") {
      live.lastStopReason = event.stopReason;
      live.lastToolCalls = event.toolCalls;
      live.lastError = event.errorMessage;

      if (event.text.trim()) {
        live.lastText = event.text;
      }

      return;
    }

    if (event.type === "tool_start") {
      deps.registry.update(id, { toolCalls: record.toolCalls + 1 });
      return;
    }

    if (event.type === "settled") {
      live.inFlight = false;

      if (live.child) {
        deps.bus.emit("agent:usage", { id, usage: live.child.ownUsage() });
      }

      if (record.state === "grace") {
        settleGrace(record, live);
        return;
      }

      const waiting =
        !event.aborted &&
        live.abortReason === undefined &&
        !record.handoffRequested &&
        (hasOpenBatches(id) || (live.outbox?.pending() ?? 0) > 0);

      if (waiting) {
        goIdle(live);
        return;
      }

      finish(record, live, event.aborted);
      void releaseLive(id);
    }
  };

  const launch = async (record: AgentRecord, item: BatchItem, plan: ModelPlan) => {
    const live = liveOf(record.id);
    const release = await semaphore.acquire();

    live.release = release;

    const current = deps.registry.get(record.id);

    if (!current || isClosed(current.state) || shuttingDown) {
      release();
      return;
    }

    const definition = deps.definitions.get(record.agent);

    if (!definition) {
      deps.registry.close(record.id, { state: "failed", error: `unknown agent "${record.agent}"` });
      release();
      return;
    }

    try {
      const child = await deps.runtime.spawn({
        id: record.id,
        cwd: deps.session()?.cwd ?? process.cwd(),
        sessionDir: record.dir,
        parentSessionFile: deps.session()?.file,
        model: plan.model,
        thinking: plan.thinking,
        tools: definition.tools,
        customTools: deps.toolsFor?.(record) ?? [],
        prompts: deps.promptsFor?.(record),
        skills: definition.skills,
        promptAppend: deps.definitions.promptAppend(definition),
        reserveTokens: deps.settings.reserveTokens,
      });

      live.child = child;
      live.unsubscribe = child.subscribe((event) => handleEvent(record.id, live, event));

      const afterSpawn = deps.registry.get(record.id);

      if (!afterSpawn || isClosed(afterSpawn.state)) {
        await releaseLive(record.id);
        return;
      }

      deps.registry.update(record.id, {
        state: "running",
        startedAt: now(),
        sessionFile: child.sessionFile,
      });

      const predecessor = record.predecessorId ? deps.registry.get(record.predecessorId) : undefined;

      live.inFlight = true;
      child.start(composeTask(record, item, fileOutputs.has(record.id), predecessor));

      const held = live.pending.splice(0);

      await Promise.all(held.map((message) => child.send(message, "steer")));
    } catch (error) {
      deps.registry.close(record.id, { state: "failed", error: `spawn failed: ${(error as Error).message}` });
      await releaseLive(record.id);
    }
  };

  const planModel = (item: BatchItem, definition: AgentDefinition): ModelPlan | { error: string } => {
    const override = item.model?.trim() ? splitModelRequest(item.model) : undefined;

    if (override?.error) {
      return { error: `${item.agent}: ${override.error}.` };
    }

    const name = override?.name || definition.model;
    const resolution = deps.runtime.resolveModel(name);

    if (resolution.kind !== "resolved") {
      return { error: resolutionError(item.agent, resolution) };
    }

    const thinking =
      resolution.thinking ?? override?.thinking ?? definition.thinking ?? deps.runtime.defaultThinking();

    return { model: resolution.model.ref, thinking, label: `${resolution.model.ref}:${thinking}` };
  };

  const allowedSubagents = (callerId: string) => {
    if (callerId === MAIN_CALLER) {
      return undefined;
    }

    const caller = deps.registry.get(callerId);

    return (caller && deps.definitions.get(caller.agent)?.subagents) ?? [];
  };

  const startBatch: Runner["startBatch"] = (items, options) => {
    if (items.length === 0) {
      throw new Error("run_agent needs at least one agent");
    }

    const unknown = items.filter((item) => !deps.definitions.get(item.agent)).map((item) => item.agent);

    if (unknown.length > 0) {
      const available = deps.definitions
        .list()
        .map((definition) => definition.name)
        .join(", ");

      throw new Error(`unknown agent(s): ${unknown.join(", ")}. Available: ${available || "none"}`);
    }

    const allowed = allowedSubagents(options.callerId);
    const forbidden = allowed
      ? items.filter((item) => !allowed.includes(item.agent)).map((item) => item.agent)
      : [];

    if (forbidden.length > 0) {
      throw new Error(
        `agent(s) not allowed for this caller: ${forbidden.join(", ")}. Allowed: ${allowed?.join(", ") || "none"}`,
      );
    }

    const depth = options.callerDepth + 1;

    if (depth > deps.settings.maxDepth) {
      throw new Error(`maximum agent depth ${deps.settings.maxDepth} reached`);
    }

    const planned = items.map((item) => planModel(item, deps.definitions.get(item.agent) as AgentDefinition));
    const modelErrors = planned.filter((plan): plan is { error: string } => "error" in plan);

    if (modelErrors.length > 0) {
      throw new Error(`${modelErrors.map((plan) => plan.error).join("\n\n")}\n\nNothing was started.`);
    }

    const plans = planned as ModelPlan[];

    const batchId = newBatchId();
    const dir = agentsDirFor(deps.session());

    let resolve: (records: AgentRecord[]) => void = () => {};

    const settled = new Promise<AgentRecord[]>((done) => {
      resolve = done;
    });

    const records = items.map((item, index) => {
      const definition = deps.definitions.get(item.agent);

      const record = deps.registry.create({
        agent: item.agent,
        task: item.task,
        description: item.description ?? item.task,
        callerId: options.callerId,
        depth,
        batchId,
        dir,
        budgetTokens: definition?.limit ?? deps.settings.budgetTokens,
        model: plans[index].label,
      });

      if (definition?.output === "file") {
        fileOutputs.add(record.id);
      }

      launches.set(record.id, { item, plan: plans[index] });

      return record;
    });

    batches.set(batchId, {
      id: batchId,
      ids: records.map((record) => record.id),
      callerId: options.callerId,
      wait: options.wait,
      woken: false,
      resolve,
    });

    records.forEach((record, index) => {
      void launch(record, items[index], plans[index]);
    });

    if (!options.wait || options.callerId === MAIN_CALLER) {
      return { batchId, records, settled };
    }

    const caller = lives.get(options.callerId);

    if (caller) {
      releaseSlot(caller);
    }

    const resumed = settled.then(async (done) => {
      if (caller) {
        caller.release = await semaphore.acquire();
      }

      return done;
    });

    return { batchId, records, settled: resumed };
  };

  const stopNow = async (record: AgentRecord) => {
    const child = lives.get(record.id)?.child;

    closeStopped(record, "stopped by the user");

    if (child) {
      await child.abort().catch(() => undefined);
      await releaseLive(record.id);
    }

    return true;
  };

  const terminalOf = (id: string) => {
    const record = deps.registry.get(id);

    return record && chainTerminal(deps.registry, record);
  };

  const stop = async (requestedId: string, options: { immediate?: boolean } = {}) => {
    const record = terminalOf(requestedId);

    if (!record || isClosed(record.state)) {
      return false;
    }

    const id = record.id;

    userStopped.add(id);

    const live = lives.get(id);
    const child = live?.child;
    const immediate =
      options.immediate === true || record.state !== "running" || deps.settings.stopGraceSeconds === 0;

    if (immediate || !live || !child) {
      return stopNow(record);
    }

    releaseSlot(live);
    deps.registry.update(id, { state: "grace", graceEndsAt: undefined });

    await child.abort().catch(() => undefined);

    const current = deps.registry.get(id);
    const idle = current?.state === "grace" && !live.graceTimer && !live.answering;

    if (idle) {
      armGrace(id, live);
    }

    return true;
  };

  const route = async (requestedId: string, message: RoutedMessage): Promise<RouteResult> => {
    const record = terminalOf(requestedId);

    if (!record) {
      return { ok: false, error: `unknown agent "${requestedId}"` };
    }

    const id = record.id;

    if (isClosed(record.state)) {
      return {
        ok: false,
        error: `agent ${id} is closed (${record.state}); closed agents cannot receive messages. Start a new agent instead.`,
      };
    }

    const live = liveOf(id);

    if (record.state === "queued" || !live.child) {
      live.pending.push(message);
      return { ok: true, delivery: "held" };
    }

    if (record.state !== "grace" && !live.inFlight) {
      void resume(id, (child) => child.send(message, "followUp"));
      return { ok: true, delivery: "followUp" };
    }

    if (record.state !== "grace") {
      await live.child.send(message, "steer");
      return { ok: true, delivery: "steer" };
    }

    clearGrace(live);
    live.answering = true;
    deps.registry.update(id, { graceEndsAt: undefined });

    await live.child.send(message, "followUp");

    return { ok: true, delivery: "followUp" };
  };

  const abort = async (requestedId: string, reason: string) => {
    const record = terminalOf(requestedId);
    const live = record && lives.get(record.id);

    if (!record || isClosed(record.state) || !live?.child) {
      return;
    }

    live.abortReason = reason;
    await live.child.abort().catch(() => undefined);
  };

  const shutdown = async (reason: string) => {
    shuttingDown = true;

    const open = deps.registry.list().filter((record) => !isClosed(record.state));

    open.forEach((record) => {
      if (record.state === "grace") {
        closeStopped(record, `stopped by the user; ${reason} ended the grace period`);
        return;
      }

      deps.registry.close(record.id, { state: "failed", error: `interrupted: ${reason}` });
    });

    await Promise.all(
      open.map(async (record) => {
        await lives
          .get(record.id)
          ?.child?.abort()
          .catch(() => undefined);
        await releaseLive(record.id);
      }),
    );
  };

  return {
    startBatch,
    batchText,
    stop,
    route,
    abort,
    shutdown,
    live: (id) => lives.get(id)?.child,
  };
};
