import type { Socket } from "node:net";
import type { AccessLogEntry } from "./access-log.ts";
import type { DenialRecord } from "./client.ts";
import type { createDenialPages } from "./denial-page.ts";
import type { Denial } from "./policy.ts";
import { ESTABLISHED, rawReply } from "./replies.ts";

type DenialInput = Pick<Denial, "rule" | "reason">;

export type RecordAccess = (entry: Omit<AccessLogEntry, "time" | "user">) => void;

export interface DenialContext {
  port?: number;
  repoHash?: string;
  sni?: string;
}

const HINTED_RULES = new Set(["egress.allow", "egress.port", "egress.cap"]);

const MAX_DENIALS = 200;

export const isHinted = (rule: string) => HINTED_RULES.has(rule);

export const denialBody = (host: string, denial: DenialInput) => ({
  denied: host,
  rule: denial.rule,
  reason: denial.reason,
});

const forbiddenStatus = (denial: DenialInput) =>
  isHinted(denial.rule) ? `403 ${denial.reason}` : "403 Forbidden";

const forbidden = (host: string, denial: DenialInput) =>
  rawReply(forbiddenStatus(denial), denialBody(host, denial));

export const createDenials = (
  record: RecordAccess,
  pages: ReturnType<typeof createDenialPages> | undefined,
) => {
  const remembered = new Map<string, DenialRecord[]>();

  const remember = (repoHash: string, entry: DenialRecord) => {
    remembered.set(repoHash, [...(remembered.get(repoHash) ?? []), entry].slice(-MAX_DENIALS));
  };

  const note = (host: string, denial: DenialInput, context: DenialContext = {}) => {
    record({
      repo: context.repoHash,
      host,
      sni: context.sni,
      decision: "deny",
      rule: denial.rule,
      reason: denial.reason,
      bytesIn: 0,
      bytesOut: 0,
    });

    if (context.repoHash !== undefined) {
      remember(context.repoHash, {
        time: Date.now(),
        host,
        port: context.port ?? 0,
        repoHash: context.repoHash,
        rule: denial.rule,
        reason: denial.reason,
      });
    }
  };

  const refuse = (socket: Socket, host: string, denial: DenialInput, context: DenialContext = {}) => {
    note(host, denial, context);

    socket.end(forbidden(host, denial));
  };

  const show = async (
    client: Socket,
    host: string,
    denial: DenialInput,
    context: { port: number; repoHash: string },
  ) => {
    note(host, denial, context);

    const secureContext = await pages?.context(host);

    if (secureContext === undefined || pages === undefined) {
      client.end(forbidden(host, denial));

      return;
    }

    if (client.destroyed) {
      return;
    }

    client.write(ESTABLISHED);

    pages.serve(client, secureContext, denial.reason);
  };

  const since = (repoHash: string, time: number) =>
    (remembered.get(repoHash) ?? []).filter((entry) => entry.time >= time);

  return { note, refuse, show, since };
};

export type Denials = ReturnType<typeof createDenials>;
