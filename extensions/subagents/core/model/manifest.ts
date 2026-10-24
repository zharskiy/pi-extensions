import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionHost } from "../../../../platform/pi-adapter/index.ts";
import { type AgentRecord, isClosed } from "./agent-record.ts";
import { MANIFEST_FILE } from "./paths.ts";

type ManifestDefaults = Pick<AgentRecord, "dir" | "handoffPath" | "contextLimit">;

const sessionCost = (host: Pick<SessionHost, "sessionUsage">, file: string | undefined) => {
  if (!file) {
    return 0;
  }

  try {
    return host.sessionUsage(file).cost.total;
  } catch {
    return 0;
  }
};

const readManifest = (dir: string): Partial<AgentRecord> =>
  JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as Partial<AgentRecord>;

const manifestRecord = (
  host: Pick<SessionHost, "sessionUsage">,
  manifest: Partial<AgentRecord>,
  defaults: ManifestDefaults,
): AgentRecord =>
  ({
    turns: 0,
    toolCalls: 0,
    tokens: 0,
    lastText: "",
    handoffRequested: false,
    chainIndex: 1,
    ...defaults,
    ...manifest,
    cost: manifest.cost ?? sessionCost(host, manifest.sessionFile),
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
  host: Pick<SessionHost, "sessionUsage">,
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
          ? [settled(manifestRecord(host, manifest, defaults(dir, manifest)))]
          : [];
      } catch {
        return [];
      }
    });
};
