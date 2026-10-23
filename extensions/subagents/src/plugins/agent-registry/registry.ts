import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { errorText } from "../../components/format.ts";
import type { Bus } from "../../model/events.ts";
import { MANIFEST_FILE } from "../../model/paths.ts";
import { type AgentRecord, type AgentRegistry, isClosed, type NewAgent } from "../../model/types.ts";

type RegistryOptions = {
  bus: Bus;
  handoffPath: (agentId: string) => string;
  newId?: (agent: string) => string;
  writeManifest?: (record: AgentRecord) => void;
};

const randomAgentId = (agent: string) => `${agent}-${randomBytes(6).toString("hex")}`;

const writeManifestFile = (record: AgentRecord) => {
  mkdirSync(record.dir, { recursive: true });
  mkdirSync(dirname(record.handoffPath), { recursive: true });

  const manifest = {
    id: record.id,
    agent: record.agent,
    description: record.description,
    callerId: record.callerId,
    depth: record.depth,
    batchId: record.batchId,
    chainIndex: record.chainIndex,
    predecessorId: record.predecessorId,
    successorId: record.successorId,
    state: record.state,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    sessionFile: record.sessionFile,
    resultPath: record.resultPath,
    handoffPath: record.state === "handoff" ? record.handoffPath : undefined,
    error: record.error,
    model: record.model,
    worktree: record.worktree,
    contextLimit: record.contextLimit,
    turns: record.turns,
    toolCalls: record.toolCalls,
    tokens: record.tokens,
  };

  writeFileSync(join(record.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
};

export const createRegistry = (options: RegistryOptions): AgentRegistry => {
  const newId = options.newId ?? randomAgentId;
  const writeManifest = options.writeManifest ?? writeManifestFile;
  const records = new Map<string, AgentRecord>();

  const uniqueId = (agent: string, dir: string): string => {
    const id = newId(agent);

    return records.has(id) || existsSync(join(dir, id)) ? uniqueId(agent, dir) : id;
  };

  const persist = (record: AgentRecord) => {
    try {
      writeManifest(record);
    } catch (error) {
      record.error ??= `manifest not written: ${errorText(error)}`;
    }
  };

  const require = (id: string) => {
    const record = records.get(id);

    if (!record) {
      throw new Error(`unknown agent "${id}"`);
    }

    return record;
  };

  const create = (input: NewAgent) => {
    const id = uniqueId(input.agent, input.dir);
    const dir = join(input.dir, id);

    const record: AgentRecord = {
      ...input,
      id,
      dir,
      chainIndex: input.chainIndex ?? 1,
      state: "queued",
      createdAt: Date.now(),
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      cost: 0,
      lastText: "",
      handoffPath: options.handoffPath(id),
      handoffRequested: false,
      version: 0,
    };

    records.set(id, record);
    persist(record);
    options.bus.emit("agent:changed", record);

    return record;
  };

  const update = (id: string, patch: Partial<AgentRecord>) => {
    const record = require(id);
    const stateChanged = patch.state !== undefined && patch.state !== record.state;
    const manifestChanged = stateChanged || "worktree" in patch;

    Object.assign(record, patch, { version: record.version + 1 });

    if (manifestChanged) {
      persist(record);
    }

    options.bus.emit("agent:changed", record);

    return record;
  };

  const close = (id: string, patch: Partial<AgentRecord> & { state: AgentRecord["state"] }) => {
    const record = require(id);

    if (isClosed(record.state)) {
      return record;
    }

    Object.assign(record, patch, { endedAt: Date.now(), version: record.version + 1 });
    persist(record);
    options.bus.emit("agent:changed", record);
    options.bus.emit("agent:closed", record);

    return record;
  };

  return {
    create,
    get: (id) => records.get(id),
    list: () => Array.from(records.values()),
    batch: (batchId) => Array.from(records.values()).filter((record) => record.batchId === batchId),
    update,
    close,
  };
};
