import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRecord, isClosed, MAIN_CALLER } from "./agent-record.ts";
import { MANIFEST_FILE } from "./paths.ts";

type ManifestDefaults = Pick<AgentRecord, "dir" | "handoffPath" | "contextLimit">;

const readManifest = (dir: string): Partial<AgentRecord> =>
  JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Partial<AgentRecord>;

const manifestRecord = (manifest: Partial<AgentRecord>, defaults: ManifestDefaults): AgentRecord =>
  ({
    lastText: "",
    handoffRequested: false,
    ...defaults,
    ...manifest,
  }) as AgentRecord;

const settled = (record: AgentRecord): AgentRecord =>
  isClosed(record.state)
    ? record
    : {
        ...record,
        state: "failed",
        endedAt: record.endedAt ?? record.createdAt,
        error: record.error ?? "interrupted",
      };

export const pastRecords = (
  agentsDir: string,
  defaults: (dir: string, manifest: Partial<AgentRecord>) => ManifestDefaults,
): AgentRecord[] => {
  if (!existsSync(agentsDir)) {
    return [];
  }

  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = join(agentsDir, entry.name);

      try {
        const manifest = readManifest(dir);

        return typeof manifest.id === "string"
          ? [settled(manifestRecord(manifest, defaults(dir, manifest)))]
          : [];
      } catch {
        return [];
      }
    });
};

type ChainKey = "predecessorId" | "successorId";

type Step = (id: string) => string | undefined;

const OTHER_END: Record<ChainKey, ChainKey> = { predecessorId: "successorId", successorId: "predecessorId" };

const reaches = (target: string, id: string | undefined, step: Step, seen: Set<string>): boolean => {
  if (id === undefined || seen.has(id)) {
    return false;
  }

  if (id === target) {
    return true;
  }

  seen.add(id);

  return reaches(target, step(id), step, seen);
};

const chainEnd = (
  byId: ReadonlyMap<string, AgentRecord>,
  record: AgentRecord,
  key: ChainKey,
): AgentRecord => {
  const linked = record[key] ? byId.get(record[key]) : undefined;

  return linked ? chainEnd(byId, linked, key) : record;
};

export const repairLinks = (records: AgentRecord[]) => {
  const ordered = [...records].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const byId = new Map(ordered.map((record) => [record.id, record]));

  const pairLink = (record: AgentRecord, key: ChainKey) => {
    const linked = record[key] ? byId.get(record[key]) : undefined;
    const back = OTHER_END[key];

    if (!linked || linked[back] === record.id) {
      return;
    }

    if (linked[back] === undefined) {
      linked[back] = record.id;
      return;
    }

    delete record[key];
  };

  ordered.forEach((record) => {
    pairLink(record, "successorId");
    pairLink(record, "predecessorId");
  });

  const successorOf: Step = (id) => byId.get(id)?.successorId;

  ordered.forEach((record) => {
    const successor = record.successorId ? byId.get(record.successorId) : undefined;

    if (successor && reaches(record.id, successor.id, successorOf, new Set())) {
      delete record.successorId;
      delete successor.predecessorId;
    }
  });

  const callerOf: Step = (id) => {
    const record = byId.get(id);
    const callerId = record ? chainEnd(byId, record, "predecessorId").callerId : MAIN_CALLER;
    const caller = callerId === MAIN_CALLER ? undefined : byId.get(callerId);

    return caller ? chainEnd(byId, caller, "successorId").id : undefined;
  };

  ordered.forEach((record) => {
    if (reaches(record.id, callerOf(record.id), callerOf, new Set())) {
      chainEnd(byId, record, "predecessorId").callerId = MAIN_CALLER;
    }
  });
};
