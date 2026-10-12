import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bus } from "../../model/events.ts";
import { type AgentRecord, type AgentRegistry, isClosed, type NewAgent } from "../../model/types.ts";

export const MANIFEST_FILE = "manifest.json";

export type RegistryOptions = {
  bus: Bus;
  now?: () => number;
  newId?: (agent: string) => string;
  writeManifest?: (record: AgentRecord) => void;
};

export const randomAgentId = (agent: string) => `${agent}-${randomBytes(2).toString("hex")}`;

export const writeManifestFile = (record: AgentRecord) => {
  mkdirSync(record.dir, { recursive: true });

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
  };

  writeFileSync(join(record.dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
};

export const createRegistry = (options: RegistryOptions): AgentRegistry => {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomAgentId;
  const writeManifest = options.writeManifest ?? writeManifestFile;
  const records = new Map<string, AgentRecord>();

  const uniqueId = (agent: string): string => {
    const id = newId(agent);

    return records.has(id) ? uniqueId(agent) : id;
  };

  const require = (id: string) => {
    const record = records.get(id);

    if (!record) {
      throw new Error(`unknown agent "${id}"`);
    }

    return record;
  };

  const create = (input: NewAgent) => {
    const id = uniqueId(input.agent);
    const dir = join(input.dir, id);

    const record: AgentRecord = {
      ...input,
      id,
      dir,
      chainIndex: input.chainIndex ?? 1,
      state: "queued",
      createdAt: now(),
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      lastText: "",
      handoffPath: join(dir, "handoff.md"),
      handoffRequested: false,
      version: 0,
    };

    records.set(id, record);
    writeManifest(record);
    options.bus.emit("agent:changed", record);

    return record;
  };

  const update = (id: string, patch: Partial<AgentRecord>) => {
    const record = require(id);
    const stateChanged = patch.state !== undefined && patch.state !== record.state;
    const manifestChanged = stateChanged || "worktree" in patch;

    Object.assign(record, patch, { version: record.version + 1 });

    if (manifestChanged) {
      writeManifest(record);
    }

    options.bus.emit("agent:changed", record);

    return record;
  };

  const close = (id: string, patch: Partial<AgentRecord> & { state: AgentRecord["state"] }) => {
    const record = require(id);

    if (isClosed(record.state)) {
      return record;
    }

    Object.assign(record, patch, { endedAt: patch.endedAt ?? now(), version: record.version + 1 });
    writeManifest(record);
    options.bus.emit("agent:changed", record);
    options.bus.emit("agent:closed", record);

    return record;
  };

  return {
    create,
    get: (id) => records.get(id),
    list: () => Array.from(records.values()),
    batch: (batchId) => {
      const members: AgentRecord[] = [];

      records.forEach((record) => {
        if (record.batchId === batchId) {
          members.push(record);
        }
      });

      return members;
    },
    update,
    close,
  };
};
