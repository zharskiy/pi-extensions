import {
  type AgentRuntime,
  createFileReader,
  type LinkRead,
  type SessionRecord,
} from "../../../../platform/pi-adapter/index.ts";
import { type AgentRecord, type AgentRegistry, chainLinks, chainTerminal } from "../model/agent-record.ts";

export type ViewData = {
  record: AgentRecord;
  chain: string[];
  session?: SessionRecord;
  error?: string;
};

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
    const readFile = createFileReader((file) => runtime.readSession(file));

    const readLink = (link: AgentRecord): LinkRead<SessionRecord> => {
      if (!link.sessionFile) {
        return { status: "missing" };
      }

      return readFile(link.sessionFile);
    };

    const errorOf = (read: LinkRead<SessionRecord> | undefined) => {
      if (read?.status === "failed") {
        return `cannot read session: ${read.error}`;
      }

      return read?.status === "missing" ? "session file not written yet" : undefined;
    };

    return (): ViewData => {
      const live = registry.get(id);
      const record = live ? chainTerminal(registry, live) : found;
      const links = chainLinks(registry, record);
      const chain = links.map((link) => link.id);
      const reads = links.map(readLink);
      const sessions = reads.flatMap((read) => (read.status === "read" ? [read.value] : []));
      const last = reads.at(-1);
      const lastSession = last?.status === "read" ? last.value : undefined;

      if (sessions.length === 0) {
        return { record, chain, error: errorOf(last) };
      }

      const session: SessionRecord = {
        providerPayload: lastSession?.providerPayload,
        contextTokens: lastSession?.contextTokens,
        items: sessions.flatMap((read) => read.items),
      };

      return { record, chain, session };
    };
  };

  return { find, loader };
};
