import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntime, Host, SessionRecord } from "../../../../../core/adapter/contract.ts";
import { agentsDirFor, handoffPathFor, MANIFEST_FILE } from "../../model/paths.ts";
import { type AgentRecord, type AgentRegistry, chainLinks, chainTerminal } from "../../model/types.ts";

export type ViewData = {
  record: AgentRecord;
  openedId?: string;
  chain: string[];
  session?: SessionRecord;
  error?: string;
};

type CachedSession = { file: string; size: number; mtimeMs: number; session: SessionRecord };

export type AgentSourceDeps = {
  host: Host;
  runtime: AgentRuntime;
  registry: AgentRegistry;
  limitOf(agent?: string): number;
};

export const createAgentSource = (deps: AgentSourceDeps) => {
  const { host, runtime, registry } = deps;

  const fromManifest = (id: string): AgentRecord | undefined => {
    const dir = join(agentsDirFor(host.session()), id);
    const path = join(dir, MANIFEST_FILE);

    if (!existsSync(path)) {
      return undefined;
    }

    const manifest = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentRecord>;

    return {
      turns: 0,
      toolCalls: 0,
      tokens: 0,
      lastText: "",
      handoffRequested: false,
      contextLimit: deps.limitOf(manifest.agent),
      chainIndex: 1,
      version: 0,
      handoffPath: handoffPathFor(host.session(), id),
      dir,
      ...manifest,
    } as AgentRecord;
  };

  const pastTerminal = (record: AgentRecord): AgentRecord => {
    const successor = record.successorId ? fromManifest(record.successorId) : undefined;

    return successor ? pastTerminal(successor) : record;
  };

  const readable = (id: string) => {
    try {
      return fromManifest(id);
    } catch {
      return undefined;
    }
  };

  const pastChain = (record: AgentRecord): string[] => {
    const predecessor = record.predecessorId ? readable(record.predecessorId) : undefined;

    return [...(predecessor ? pastChain(predecessor) : []), record.id];
  };

  const find = (id: string): AgentRecord | undefined => {
    const live = registry.get(id);

    if (live) {
      return chainTerminal(registry, live);
    }

    const past = fromManifest(id);

    return past ? pastTerminal(past) : undefined;
  };

  const loader = (id: string, found: AgentRecord) => {
    let cached: CachedSession | undefined;

    const readSession = (file: string) => {
      const stat = statSync(file, { throwIfNoEntry: false });

      if (!stat) {
        return undefined;
      }

      if (cached?.file === file && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.session;
      }

      const session = runtime.readSession(file);

      cached = { file, size: stat.size, mtimeMs: stat.mtimeMs, session };

      return session;
    };

    return (): ViewData => {
      const live = registry.get(id);
      const record = live ? chainTerminal(registry, live) : found;
      const openedId = record.id === id ? undefined : id;
      const chain = live ? chainLinks(registry, record).map((link) => link.id) : pastChain(record);

      try {
        const session = record.sessionFile ? readSession(record.sessionFile) : undefined;

        return session
          ? { record, openedId, chain, session }
          : { record, openedId, chain, error: "session file not written yet" };
      } catch (error) {
        return { record, openedId, chain, error: `cannot read session: ${(error as Error).message}` };
      }
    };
  };

  return { find, loader };
};
