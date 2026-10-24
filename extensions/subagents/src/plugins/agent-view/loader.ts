import { statSync } from "node:fs";
import type { AgentRuntime, SessionRecord } from "../../../../../pi-adapter/index.ts";
import { errorText } from "../../components/format.ts";
import { type AgentRecord, type AgentRegistry, chainLinks, chainTerminal } from "../../model/types.ts";

export type ViewData = {
  record: AgentRecord;
  chain: string[];
  session?: SessionRecord;
  error?: string;
};

type CachedSession = { file: string; size: number; mtimeMs: number; session: SessionRecord };

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
      const chain = chainLinks(registry, record).map((link) => link.id);

      try {
        const session = record.sessionFile ? readSession(record.sessionFile) : undefined;

        return session
          ? { record, chain, session }
          : { record, chain, error: "session file not written yet" };
      } catch (error) {
        return { record, chain, error: `cannot read session: ${errorText(error)}` };
      }
    };
  };

  return { find, loader };
};
