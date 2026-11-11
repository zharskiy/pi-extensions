import type { Socket } from "node:net";
import type { AccessLogEntry } from "./access-log.ts";
import type { DenialRecord } from "./client.ts";
import type { createDenialPages } from "./denial-page.ts";
import type { Denial } from "./policy.ts";
import { ESTABLISHED, rawReply } from "./replies.ts";

type DenialInput = Pick<Denial, "rule" | "reason">;

export type RecordAccess = (entry: Omit<AccessLogEntry, "time" | "user" | "repo">) => void;

export interface DenialContext {
  port?: number;
  sni?: string;
  credentialRule?: string;
}

const MAX_DENIALS = 200;

export const isHinted = (rule: string) => rule === "egress.allow";

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
  repoHash: string,
  record: RecordAccess,
  pages: ReturnType<typeof createDenialPages>,
) => {
  const state: { remembered: DenialRecord[] } = { remembered: [] };

  const log = (host: string, denial: DenialInput, context: DenialContext = {}) => {
    record({
      host,
      sni: context.sni,
      decision: "deny",
      rule: denial.rule,
      reason: denial.reason,
      bytesIn: 0,
      bytesOut: 0,
    });
  };

  const note = (host: string, denial: DenialInput, context: DenialContext = {}) => {
    log(host, denial, context);

    const entry = {
      time: Date.now(),
      host,
      port: context.port ?? 0,
      repoHash,
      rule: denial.rule,
      reason: denial.reason,
      ...(context.credentialRule === undefined ? {} : { credentialRule: context.credentialRule }),
    };

    state.remembered = [...state.remembered, entry].slice(-MAX_DENIALS);
  };

  const refuse = (socket: Socket, host: string, denial: DenialInput, context: DenialContext = {}) => {
    note(host, denial, context);

    socket.end(forbidden(host, denial));
  };

  const show = async (client: Socket, host: string, denial: DenialInput, context: { port: number }) => {
    note(host, denial, context);

    const secureContext = await pages.context(host);

    if (secureContext === undefined) {
      client.end(forbidden(host, denial));

      return;
    }

    if (client.destroyed) {
      return;
    }

    client.write(ESTABLISHED);

    pages.serve(client, secureContext, denial.reason);
  };

  const since = (time: number) => state.remembered.filter((entry) => entry.time >= time);

  return { log, note, refuse, show, since };
};

export type Denials = ReturnType<typeof createDenials>;
