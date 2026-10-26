import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type AgentRuntime,
  type AnyToolSpec,
  type ChildEvent,
  type ChildSession,
  type CustomMessage,
  type RoutedMessage,
  type SessionInfo,
  type StopReason,
  settleWithin,
  splitModelRequest,
  type UsageTotals,
} from "../../../../platform/pi-adapter/index.ts";
import {
  errorText,
  HANDOFF_SEED_TYPE,
  readText,
  seedText,
  successorPreface,
} from "../../../../platform/shared/index.ts";
import {
  type AgentDefinition,
  type AgentDefinitions,
  type AgentRecord,
  type AgentRegistry,
  type AgentRunner,
  allowlist,
  chainLinks,
  chainTerminal,
  isClosed,
  MAIN_CALLER,
  type RouteResult,
  subagentNames,
} from "../model/agent-record.ts";
import { AGENT_SCOPE_ALL } from "../model/agent-schema.ts";
import type { Bus } from "../model/events.ts";
import { handoffService } from "../model/handoff.ts";
import { agentsDirFor } from "../model/paths.ts";
import type { Settings } from "../model/settings.ts";
import { resolutionError } from "./model-text.ts";
import { createOutbox, joinTexts, type Outbox } from "./outbox.ts";
import { createPlacer } from "./placement.ts";
import { batchMessage, pickResult, storeResult } from "./result.ts";
import { createSemaphore } from "./semaphore.ts";
import { composeTask } from "./task.ts";

type ModelPlan = { model: string; thinking: string; label: string };

type RunnerDeps = {
  registry: AgentRegistry;
  runtime: AgentRuntime;
  bus: Bus;
  settings: Settings;
  definitions: AgentDefinitions;
  outbox: Pick<Outbox, "post">;
  session: () => SessionInfo;
  toolsFor: (record: AgentRecord) => AnyToolSpec[];
};

export type BatchItem = {
  agent: string;
  task: string;
  files?: string[];
  description?: string;
  model?: string;
  skills?: string[];
};

type BatchOptions = { callerId: string; wait: boolean };

type StartedBatch = { batchId: string; records: AgentRecord[]; settled: Promise<AgentRecord[]> };

export type Runner = AgentRunner & {
  startBatch(items: BatchItem[], options: BatchOptions): StartedBatch;
  batchText(batchId: string): string;
  stop(id: string, options?: { immediate?: boolean }): Promise<boolean>;
  shutdown(reason: string): Promise<void>;
};

type Batch = {
  id: string;
  ids: string[];
  callerId: string;
  wait: boolean;
  resolve: (records: AgentRecord[]) => void;
};

type LaunchSlot = {
  item: BatchItem;
  definition: AgentDefinition;
  plan: ModelPlan;
  undelivered?: string[];
  seed?: CustomMessage;
};

type Live = {
  child?: ChildSession;
  spawning?: Promise<ChildSession | undefined>;
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
  turn: "idle" | "waiting" | "running";
  outbox?: Outbox;
  idleHandlers: (() => void)[];
};

const failedStop = (reason: StopReason | undefined) => reason === "error" || reason === "aborted";

const ABORT_WAIT_MS = 5_000;

const newBatchId = () => `b-${randomBytes(3).toString("hex")}`;

const unique = (names: string[]) => [...new Set(names)];

export const createRunner = (deps: RunnerDeps): Runner => {
  const { place, release } = createPlacer(deps.registry);
  const semaphore = createSemaphore(() => deps.settings.maxConcurrent);
  const batches = new Map<string, Batch>();
  const lives = new Map<string, Live>();
  const launches = new Map<string, LaunchSlot>();
  const spawned = new Map<string, number>();
  const userStopped = new Set<string>();
  const releasing = new Set<string>();
  const teardowns = new Map<string, Promise<void>>();
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
      turn: "idle",
      idleHandlers: [],
    };

    lives.set(id, created);

    return created;
  };

  const batchText = (batchId: string) =>
    batchMessage(batchId, deps.registry.batch(batchId), deps.settings.inlineResultChars);

  const settledTerminals = (batch: Batch) => {
    const records = batch.ids.map((id) => deps.registry.get(id)).filter((entry) => entry !== undefined);

    const settled = records.every((entry) => isClosed(entry.state) && !releasing.has(entry.id));

    return settled ? records.filter((entry) => !entry.successorId) : undefined;
  };

  const checkBatch = (record: AgentRecord) => {
    const batch = batches.get(record.batchId);
    const terminals = batch && settledTerminals(batch);

    if (!batch || !terminals) {
      return;
    }

    batches.delete(batch.id);
    batch.resolve(terminals);
    deps.bus.emit("batch:settled", { batchId: batch.id });

    if (batch.wait || shuttingDown) {
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

  const onClosed = (record: AgentRecord) => {
    if (record.worktree && !record.successorId) {
      releasing.add(record.id);
    }

    checkBatch(record);
    launches.delete(record.id);
    userStopped.delete(record.id);

    if (!shuttingDown) {
      stopChildrenOf(record);
    }
  };

  deps.bus.on("agent:closed", onClosed);

  const hasOpenBatches = (callerId: string) =>
    Array.from(batches.values()).some((batch) => batch.callerId === callerId && !batch.wait);

  const sendHeld = (live: Live, child: ChildSession) =>
    Promise.all(live.pending.splice(0).map((message) => child.send(message, "steer")));

  const resume = async (id: string, deliver: (child: ChildSession) => Promise<void>) => {
    const live = lives.get(id);

    if (!live?.child) {
      return;
    }

    live.turn = "waiting";

    const release = await semaphore.acquire();
    const record = deps.registry.get(id);
    const child = live.child;

    if (!record || isClosed(record.state) || shuttingDown || !child) {
      release();
      live.turn = "idle";
      return;
    }

    live.release = release;
    live.turn = "running";

    try {
      await deliver(child);
      await sendHeld(live, child);
    } catch (error) {
      deps.registry.close(id, { state: "failed", error: `wake failed: ${errorText(error)}` });
      await releaseLive(id);
    }
  };

  const callerOutbox = (callerId: string): Pick<Outbox, "post"> | undefined => {
    if (callerId === MAIN_CALLER) {
      return deps.outbox;
    }

    const record = deps.registry.get(callerId);
    const live = lives.get(callerId);

    if (!record || isClosed(record.state) || !live) {
      return undefined;
    }

    live.outbox ??= createOutbox({
      isBusy: () => live.turn !== "idle",
      deliver: (items) => {
        void resume(callerId, (child) => child.wake(joinTexts(items)));
      },
      onIdle: (handler) => {
        live.idleHandlers.push(handler);
      },
    });

    return live.outbox;
  };

  const abortChild = (child: ChildSession) => settleWithin(child.abort(), ABORT_WAIT_MS);

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

  const noteUsage = (id: string, usage: UsageTotals) => {
    const record = deps.registry.get(id);

    if (record && record.cost !== usage.cost.total) {
      deps.registry.update(id, { cost: usage.cost.total });
    }

    deps.bus.emit("agent:usage", { id, usage });
  };

  const disposeLive = async (id: string, live: Live) => {
    live.unsubscribe?.();
    live.turn = "idle";
    live.outbox?.clear();
    releaseSlot(live);

    lives.delete(id);

    const child = await live.spawning;

    live.child = undefined;

    if (child) {
      noteUsage(id, child.ownUsage());
      await child.dispose().catch(() => undefined);
    }
  };

  const teardown = async (id: string) => {
    const live = lives.get(id);

    if (live) {
      await disposeLive(id, live);
    }

    const record = deps.registry.get(id);

    if (record?.worktree && releasing.has(id)) {
      await release(record, record.worktree);
      releasing.delete(id);
      checkBatch(record);
    }
  };

  const releaseLive = (id: string) => {
    const running = teardowns.get(id) ?? teardown(id).finally(() => teardowns.delete(id));

    teardowns.set(id, running);

    return running;
  };

  const replyText = (live: Live) => (live.child?.runTexts().at(-1) ?? live.lastText).trim();

  const replyHandoff = (live: Live) => {
    const text = replyText(live);

    return text.length > 0 && handoffService.validate(text).ok ? text : undefined;
  };

  const saveReplyHandoff = (record: AgentRecord, live: Live): { text?: string; error?: string } => {
    const text = replyHandoff(live);

    if (text === undefined) {
      return {
        error: `context limit reached but no handoff file was written at ${record.handoffPath} and the final reply is not a handoff`,
      };
    }

    try {
      mkdirSync(dirname(record.handoffPath), { recursive: true });
      writeFileSync(record.handoffPath, `${text}\n`);

      return { text };
    } catch (error) {
      return { error: `handoff reply not written to ${record.handoffPath}: ${errorText(error)}` };
    }
  };

  const finishHandoff = (record: AgentRecord, live: Live) => {
    const saved = readText(record.handoffPath);
    const { text, error } =
      saved === undefined ? saveReplyHandoff(record, live) : { text: saved, error: undefined };

    if (text === undefined) {
      return deps.registry.close(record.id, { state: "failed", error });
    }

    const validation = handoffService.validate(text);

    if (!validation.ok) {
      return deps.registry.close(record.id, {
        state: "handoff",
        resultText: text,
        error: validation.errors.join("; "),
      });
    }

    const slot = launches.get(record.id);
    const batch = batches.get(record.batchId);

    if (validation.status === "partial" && slot && batch && canContinue(record)) {
      return continueChain(record, text, { ...slot, undelivered: live.outbox?.clear() }, batch);
    }

    return deps.registry.close(record.id, { state: "handoff", resultText: text });
  };

  const canContinue = (record: AgentRecord) =>
    record.chainIndex < deps.settings.maxChainLength &&
    record.state !== "grace" &&
    !userStopped.has(record.id) &&
    !shuttingDown;

  const continueChain = (record: AgentRecord, text: string, slot: LaunchSlot, batch: Batch) => {
    const successor = deps.registry.create({
      agent: record.agent,
      description: record.description,
      callerId: record.callerId,
      depth: record.depth,
      batchId: record.batchId,
      dir: dirname(record.dir),
      contextLimit: record.contextLimit,
      model: record.model,
      skills: record.skills,
      chainIndex: record.chainIndex + 1,
      predecessorId: record.id,
      worktree: record.worktree,
    });

    const link = { id: record.id, link: successor.chainIndex };

    const successorSlot: LaunchSlot = {
      ...slot,
      seed: {
        customType: HANDOFF_SEED_TYPE,
        text: seedText(successorPreface({ kind: "agent", ...link, path: record.handoffPath }), text),
        details: { from: "agent", ...link },
      },
    };

    launches.set(successor.id, successorSlot);

    batch.ids.push(successor.id);

    const closed = deps.registry.close(record.id, {
      state: "handoff",
      resultText: text,
      successorId: successor.id,
    });

    void launch(successor, successorSlot);

    return closed;
  };

  const finalText = (live: Live) => pickResult(live.child?.runTexts() ?? []);

  const partialResult = (record: AgentRecord, text: string, error: string) => {
    if (text.length === 0) {
      return { error };
    }

    const { error: storeError, ...stored } = storeResult(record, text);

    return { ...stored, error: storeError ? `${error}; ${storeError}` : error };
  };

  const finish = (record: AgentRecord, live: Live, aborted: boolean) => {
    if (isClosed(record.state)) {
      return;
    }

    if (record.handoffRequested) {
      finishHandoff(record, live);
      return;
    }

    const { text, statusLine } = finalText(live);

    if (aborted || failedStop(live.lastStopReason)) {
      const error =
        live.abortReason ?? live.lastError ?? (aborted ? "aborted" : `stopped with ${live.lastStopReason}`);

      deps.registry.close(record.id, { state: "failed", ...partialResult(record, text, error) });

      return;
    }

    if (text.length === 0) {
      deps.registry.close(record.id, { state: "failed", error: "agent finished with an empty result" });
      return;
    }

    const result = storeResult(record, text);

    deps.registry.close(record.id, { state: "done", ...result, statusLine });
  };

  const clearGrace = (live: Live | undefined) => {
    if (live) {
      clearTimeout(live.graceTimer);
      live.graceTimer = undefined;
    }
  };

  const closeStopped = (record: AgentRecord, error: string) => {
    const live = lives.get(record.id);

    clearGrace(live);

    const text = live ? finalText(live).text : "";

    deps.registry.close(record.id, {
      state: "stopped",
      graceEndsAt: undefined,
      ...partialResult(record, text, error),
    });
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

    deps.registry.update(id, { graceEndsAt: Date.now() + graceMs });
    live.graceTimer = setTimeout(() => void expireGrace(id), graceMs);
  };

  const settleGrace = (record: AgentRecord, live: Live) => {
    live.answering = false;
    releaseSlot(live);

    const handoffWritten =
      record.handoffRequested && (existsSync(record.handoffPath) || replyHandoff(live) !== undefined);

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
      const cost = usage ? usage.cost.total : record.cost;
      const turns = record.turns + 1;

      deps.registry.update(id, { turns, context: event.context, tokens, cost, lastText: live.lastText });

      if (usage) {
        deps.bus.emit("agent:usage", { id, usage });
      }

      const continuing =
        live.lastToolCalls > 0 && live.lastStopReason !== undefined && !failedStop(live.lastStopReason);

      deps.bus.emit("agent:turn", { id, context: event.context, turns, continuing });

      return;
    }

    if (event.type === "assistant_message") {
      live.lastStopReason = event.stopReason;
      live.lastToolCalls = event.toolCalls;
      live.lastError = event.errorMessage;

      if (event.text.trim()) {
        live.lastText = event.text;

        if (record.activity !== "writing") {
          deps.registry.update(id, { activity: "writing" });
        }
      }

      return;
    }

    if (event.type === "tool_start") {
      deps.registry.update(id, {
        toolCalls: record.toolCalls + 1,
        activity: event.toolName,
      });
      return;
    }

    if (event.type === "settled") {
      if (live.turn === "running") {
        live.turn = "idle";
      }

      if (live.child) {
        noteUsage(id, live.child.ownUsage());
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
        deps.registry.update(id, { activity: undefined });
        goIdle(live);
        return;
      }

      finish(record, live, event.aborted);
      void releaseLive(id);
    }
  };

  const launch = async (record: AgentRecord, slot: LaunchSlot) => {
    const live = liveOf(record.id);

    live.release = await semaphore.acquire();

    const current = deps.registry.get(record.id);

    if (!current || isClosed(current.state) || shuttingDown) {
      releaseSlot(live);
      await releaseLive(record.id);
      return;
    }

    const session = deps.session();
    const definition = slot.definition;

    const placement = await place(record, definition, session.cwd);

    if ("error" in placement) {
      deps.registry.close(record.id, { state: "failed", error: placement.error });
      await releaseLive(record.id);
      return;
    }

    const placed = deps.registry.get(record.id);

    if (!placed || isClosed(placed.state) || shuttingDown) {
      await releaseLive(record.id);
      return;
    }

    live.spawning = deps.runtime
      .spawn({
        id: record.id,
        cwd: placement.cwd,
        sessionDir: record.dir,
        parentSessionFile: session.file,
        model: slot.plan.model,
        thinking: slot.plan.thinking,
        tools: allowlist(definition.tools),
        customTools: deps.toolsFor(record),
        skills: record.skills ?? [],
        mcp: definition.mcp ?? true,
        promptAppend: deps.definitions.promptAppend(definition),
        reserveTokens: deps.settings.reserveTokens,
      })
      .catch((error: unknown) => {
        deps.registry.close(record.id, {
          state: "failed",
          error: `spawn failed: ${errorText(error)}`,
        });
        return undefined;
      });

    const child = await live.spawning;

    if (!child || lives.get(record.id) !== live) {
      await releaseLive(record.id);
      return;
    }

    live.child = child;
    live.unsubscribe = child.subscribe((event) => handleEvent(record.id, live, event));

    const afterSpawn = deps.registry.get(record.id);

    if (!afterSpawn || isClosed(afterSpawn.state)) {
      await releaseLive(record.id);
      return;
    }

    deps.registry.update(record.id, {
      state: "running",
      startedAt: Date.now(),
      sessionFile: child.sessionFile,
    });

    live.turn = "running";

    try {
      child.start(composeTask(record, slot.item, slot.undelivered), slot.seed);
      await sendHeld(live, child);
    } catch (error) {
      deps.registry.close(record.id, { state: "failed", error: `start failed: ${errorText(error)}` });
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

    const thinking = override?.thinking ?? definition.thinking ?? deps.runtime.defaultThinking();

    return { model: resolution.model.ref, thinking, label: `${resolution.model.ref}:${thinking}` };
  };

  const allowedSubagents = (callerId: string) => {
    if (callerId === MAIN_CALLER) {
      return undefined;
    }

    const caller = deps.registry.get(callerId);
    const definition = caller && deps.definitions.get(caller.agent);

    if (!definition) {
      return [];
    }

    return subagentNames(
      definition,
      deps.definitions.list().map((agent) => agent.name),
    );
  };

  const callerSkills = (callerId: string) =>
    callerId === MAIN_CALLER ? deps.runtime.sessionSkillNames() : (deps.registry.get(callerId)?.skills ?? []);

  const skillNamesFor = (definition: AgentDefinition, item: BatchItem, callerId: string) => {
    const own = definition.skills === AGENT_SCOPE_ALL ? callerSkills(callerId) : definition.skills;

    return unique(own.concat(item.skills ?? []));
  };

  const skillError = (item: BatchItem, definition: AgentDefinition, available: string[]) => {
    const tools = definition.tools;
    const unknownSkills = unique(item.skills ?? []).filter((name) => !available.includes(name));

    if (unknownSkills.length > 0) {
      const listed = unknownSkills.map((name) => `"${name}"`).join(", ");
      const valid =
        available.length > 0
          ? `This caller's skills: ${available.join(", ")}.`
          : "This caller has no skills.";

      return `${item.agent}: skill(s) ${listed} not in this caller's skills. ${valid}`;
    }

    if (item.skills?.length && tools !== AGENT_SCOPE_ALL && !tools.includes("read")) {
      return `${item.agent}: cannot use skills, its tools do not include read.`;
    }

    return undefined;
  };

  const chainRoot = (callerId: string) => {
    const caller = deps.registry.get(callerId);

    return caller ? chainLinks(deps.registry, caller)[0].id : callerId;
  };

  const capError = (callerId: string, count: number) => {
    if (callerId === MAIN_CALLER) {
      return undefined;
    }

    const cap = deps.settings.maxChildrenPerAgent;
    const started = spawned.get(chainRoot(callerId)) ?? 0;

    if (started + count <= cap) {
      return undefined;
    }

    return `agent ${callerId} may start at most ${cap} agents per run and has started ${started}; nothing was started. Finish with what you have and list the rest under Open.`;
  };

  const startBatch: Runner["startBatch"] = (items, options) => {
    const unknownAgents = items.filter((item) => !deps.definitions.get(item.agent)).map((item) => item.agent);

    if (unknownAgents.length > 0) {
      const available = deps.definitions
        .list()
        .map((definition) => definition.name)
        .join(", ");

      throw new Error(`unknown agent(s): ${unknownAgents.join(", ")}. Available: ${available || "none"}`);
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

    const depth = (deps.registry.get(options.callerId)?.depth ?? 1) + 1;

    if (depth > deps.settings.maxDepth) {
      throw new Error(`maximum agent depth ${deps.settings.maxDepth} reached`);
    }

    const capped = capError(options.callerId, items.length);

    if (capped) {
      throw new Error(capped);
    }

    const definitions = items.map((item) => deps.definitions.get(item.agent) as AgentDefinition);
    const available = items.some((item) => item.skills?.length) ? callerSkills(options.callerId) : [];
    const skillErrors = items
      .map((item, index) => skillError(item, definitions[index], available))
      .filter((error) => error !== undefined);

    if (skillErrors.length > 0) {
      throw new Error(`${skillErrors.join("\n")} Nothing was started.`);
    }

    const planned = items.map((item, index) => planModel(item, definitions[index]));
    const modelErrors = planned.filter((plan): plan is { error: string } => "error" in plan);

    if (modelErrors.length > 0) {
      throw new Error(`${modelErrors.map((plan) => plan.error).join("\n\n")}\n\nNothing was started.`);
    }

    const slots = (planned as ModelPlan[]).map(
      (plan, index): LaunchSlot => ({ item: items[index], definition: definitions[index], plan }),
    );

    if (options.callerId !== MAIN_CALLER) {
      const root = chainRoot(options.callerId);

      spawned.set(root, (spawned.get(root) ?? 0) + items.length);
    }

    const batchId = newBatchId();
    const dir = agentsDirFor(deps.session());

    let resolve: (records: AgentRecord[]) => void = () => {};

    const settled = new Promise<AgentRecord[]>((done) => {
      resolve = done;
    });

    const records = slots.map((slot) => {
      const { item, definition, plan } = slot;

      const record = deps.registry.create({
        agent: item.agent,
        description: item.description ?? item.task,
        callerId: options.callerId,
        depth,
        batchId,
        dir,
        contextLimit: definition.limit,
        model: plan.label,
        skills: skillNamesFor(definition, item, options.callerId),
      });

      launches.set(record.id, slot);

      return record;
    });

    batches.set(batchId, {
      id: batchId,
      ids: records.map((record) => record.id),
      callerId: options.callerId,
      wait: options.wait,
      resolve,
    });

    records.forEach((record, index) => {
      void launch(record, slots[index]);
    });

    if (!options.wait || options.callerId === MAIN_CALLER) {
      return { batchId, records, settled };
    }

    const caller = lives.get(options.callerId);

    if (caller) {
      releaseSlot(caller);
    }

    const resumed = settled.then(async (done) => {
      if (!caller || shuttingDown) {
        return done;
      }

      const release = await semaphore.acquire();
      const record = deps.registry.get(options.callerId);

      if (!record || isClosed(record.state) || shuttingDown) {
        release();
      } else {
        caller.release = release;
      }

      return done;
    });

    return { batchId, records, settled: resumed };
  };

  const stopNow = async (record: AgentRecord) => {
    const live = lives.get(record.id);
    const child = live?.child;
    const waitingForSlot = live !== undefined && !child && !live.release;

    closeStopped(record, "stopped by the user");

    if (child) {
      await abortChild(child);
    }

    if (child || waitingForSlot) {
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

    await abortChild(child);

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

    if (record.state === "queued" || !live.child || live.turn === "waiting") {
      live.pending.push(message);
      return { ok: true, delivery: "held" };
    }

    if (record.state === "grace") {
      clearGrace(live);
      live.answering = true;
      deps.registry.update(id, { graceEndsAt: undefined });
    }

    if (live.turn === "running") {
      await live.child.send(message, "steer");
      return { ok: true, delivery: "steer" };
    }

    void resume(id, (child) => child.send(message, "followUp"));

    return { ok: true, delivery: "followUp" };
  };

  const abort = async (requestedId: string, reason: string) => {
    const record = terminalOf(requestedId);
    const live = record && lives.get(record.id);

    if (!record || isClosed(record.state) || !live?.child) {
      return;
    }

    live.abortReason = reason;

    await abortChild(live.child);
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
        const child = lives.get(record.id)?.child;

        if (child) {
          await abortChild(child);
        }

        await releaseLive(record.id);
      }),
    );

    await Promise.all(Array.from(releasing, releaseLive));
  };

  return {
    startBatch,
    batchText,
    stop,
    route,
    abort,
    shutdown,
  };
};
