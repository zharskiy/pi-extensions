import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "../../../../core/adapter/contract.ts";
import { MANIFEST_FILE } from "./paths.ts";
import { type AgentRecord, isClosed } from "./types.ts";

export type ManifestDefaults = Pick<AgentRecord, "dir" | "handoffPath" | "contextLimit" | "cost">;

export const sessionCost = (host: Pick<Host, "sessionUsage">, file: string | undefined) => {
  if (!file) {
    return 0;
  }

  try {
    return host.sessionUsage(file).cost.total;
  } catch {
    return 0;
  }
};

export const readManifest = (dir: string): Partial<AgentRecord> =>
  JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Partial<AgentRecord>;

export const manifestRecord = (manifest: Partial<AgentRecord>, defaults: ManifestDefaults): AgentRecord =>
  ({
    turns: 0,
    toolCalls: 0,
    tokens: 0,
    lastText: "",
    handoffRequested: false,
    chainIndex: 1,
    version: 0,
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
