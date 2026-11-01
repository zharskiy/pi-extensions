import { statSync } from "node:fs";
import type { AgentRuntime, SessionRecord } from "../../../../platform/pi-adapter/index.ts";
import { errorText } from "../../../../platform/shared/index.ts";
import { type AgentRecord, type AgentRegistry, chainLinks, chainTerminal } from "../model/agent-record.ts";

export type ViewData = {
  record: AgentRecord;
  chain: string[];
  session?: SessionRecord;
  linkItems?: number[];
  error?: string;
};

type CachedSession = { size: number; mtimeMs: number; session: SessionRecord };

type LinkRead = { session?: SessionRecord; error?: string };

type AgentSourceDeps = {
  runtime: AgentRuntime;
  registry: AgentRegistry;
};

export const createAgentSource = ({ runtime, registry }: AgentSourceDeps) => {
  const find = (id: string): AgentRecord | undefined => {
    const live = registry.get(id);

    return live && chainTerminal(registry, live);
  };

  const loader = (id: string, found: AgentRecord) => {
    const cache = new Map<string, CachedSession>();

    const readSession = (file: string) => {
      const stat = statSync(file, { throwIfNoEntry: false });

      if (!stat) {
        return undefined;
      }

      const cached = cache.get(file);

      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.session;
      }

      const session = runtime.readSession(file);

      cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, session });

      return session;
    };

    const readLink = (link: AgentRecord): LinkRead => {
      try {
        const session = link.sessionFile ? readSession(link.sessionFile) : undefined;

        return session ? { session } : { error: "session file not written yet" };
      } catch (error) {
        return { error: `cannot read session: ${errorText(error)}` };
      }
    };

    return (): ViewData => {
      const live = registry.get(id);
      const record = live ? chainTerminal(registry, live) : found;
      const links = chainLinks(registry, record);
      const chain = links.map((link) => link.id);
      const reads = links.map(readLink);
      const sessions = reads.flatMap((read) => (read.session ? [read.session] : []));
      const linkItems = reads.map((read) => read.session?.items.length ?? 0);
      const last = reads.at(-1);

      if (sessions.length === 0) {
        return { record, chain, error: last?.error };
      }

      const session: SessionRecord = {
        providerPayload: last?.session?.providerPayload,
        contextTokens: last?.session?.contextTokens,
        items: sessions.flatMap((read) => read.items),
      };

      return { record, chain, session, linkItems, error: last?.error };
    };
  };

  return { find, loader };
};
