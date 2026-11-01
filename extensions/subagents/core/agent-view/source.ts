import {
  type AgentRuntime,
  createFileReader,
  type LinkRead,
  type SessionRecord,
  type TranscriptItem,
} from "../../../../platform/pi-adapter/index.ts";
import { LIMIT_SEAM } from "../../../../platform/shared/index.ts";
import { type AgentRecord, type AgentRegistry, chainLinks, chainTerminal } from "../model/agent-record.ts";

export type ViewData = {
  record: AgentRecord;
  chain: string[];
  session?: SessionRecord;
  linkItems?: number[];
  error?: string;
  pending?: string;
};

const SEAM: TranscriptItem = { kind: "rule", label: LIMIT_SEAM };

const NOT_WRITTEN = "session file not written yet";

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

      return read?.status === "missing" ? NOT_WRITTEN : undefined;
    };

    return (): ViewData => {
      const live = registry.get(id);
      const record = live ? chainTerminal(registry, live) : found;
      const links = chainLinks(registry, record);
      const chain = links.map((link) => link.id);
      const reads = links.map(readLink);
      const sessions = reads.flatMap((read) => (read.status === "read" ? [read.value] : []));
      const parts = reads.map((read, index) => {
        if (read.status !== "read") {
          return [];
        }

        const after = reads.slice(0, index).some((earlier) => earlier.status === "read");

        return after ? [SEAM, ...read.value.items] : read.value.items;
      });
      const linkItems = parts.map((part) => part.length);
      const last = reads.at(-1);
      const lastSession = last?.status === "read" ? last.value : undefined;

      if (sessions.length === 0) {
        return { record, chain, error: reads.map(errorOf).find((error) => error !== undefined) };
      }

      const waiting = last?.status === "missing";
      const error =
        reads
          .slice(0, -1)
          .map(errorOf)
          .find((text) => text !== undefined) ?? (waiting ? undefined : errorOf(last));
      const pending = error === undefined && waiting ? NOT_WRITTEN : undefined;

      const session: SessionRecord = {
        providerPayload: lastSession?.providerPayload,
        items: parts.flat(),
      };

      return { record, chain, session, linkItems, error, pending };
    };
  };

  return { find, loader };
};
