import { errorText } from "../../../core/manager/format.ts";
import { isPlainObject } from "../../../core/manager/settings.ts";
import type { Source } from "./args.ts";
import { type ConvertContext, convertServer, type PiServer, validName } from "./convert.ts";
import type { Origin } from "./sources.ts";

export type Entry = { name: string; origin: string; server: PiServer; notes: string[] };

type Skipped = { name: string; origin: string; reason: string };

type Target = { label: string; text?: string };

export type Plan = { added: Entry[]; skipped: Skipped[]; text?: string; error?: string };

type Parsed = { config: Record<string, unknown>; servers: Record<string, unknown>; indent: string };

const namespace = (name: string) => name.replace(/-/g, "_");

const parseTarget = (target: Target): Parsed | string => {
  const indent = (target.text && /^([ \t]+)\S/m.exec(target.text)?.[1]) || "  ";

  if (target.text === undefined || target.text.trim() === "") {
    return { config: {}, servers: {}, indent };
  }

  try {
    const config: unknown = JSON.parse(target.text);

    if (!isPlainObject(config) || (config.mcpServers !== undefined && !isPlainObject(config.mcpServers))) {
      return `${target.label}: expected an object with an "mcpServers" object`;
    }

    return { config, servers: isPlainObject(config.mcpServers) ? config.mcpServers : {}, indent };
  } catch (error) {
    return `${target.label}: ${errorText(error)}`;
  }
};

const mergeText = (parsed: Parsed, entries: readonly Entry[]) => {
  const servers = {
    ...parsed.servers,
    ...Object.fromEntries(entries.map((entry) => [entry.name, entry.server])),
  };

  return `${JSON.stringify({ ...parsed.config, mcpServers: servers }, null, parsed.indent)}\n`;
};

type Candidate = { name: string; origin: string; raw: unknown; note?: string };

export const planImport = (
  source: Source,
  origins: readonly Origin[],
  target: Target,
  context: ConvertContext,
): Plan => {
  const parsed = parseTarget(target);

  if (typeof parsed === "string") {
    return { added: [], skipped: [], error: parsed };
  }

  const candidates: Candidate[] = origins.flatMap((origin) =>
    Object.entries(origin.servers).map(([name, raw]) => ({
      name,
      origin: origin.label,
      raw,
      note: origin.note,
    })),
  );

  const existing = Object.keys(parsed.servers);

  const step = (plan: Plan, candidate: Candidate, index: number): Plan => {
    const { name, origin } = candidate;
    const skip = (reason: string): Plan => ({
      ...plan,
      skipped: [...plan.skipped, { name, origin, reason }],
    });
    const first = candidates.findIndex((other) => other.name === name);

    if (first < index) {
      return skip(`also defined in ${candidates[first].origin}, which wins`);
    }

    if (!validName(name)) {
      return skip("pi server names use only letters, digits, _ and -");
    }

    const clash = existing.find((other) => namespace(other) === namespace(name));

    if (clash !== undefined) {
      return skip(
        clash === name
          ? `already in ${target.label}, left unchanged`
          : `pi treats it as the same server as "${clash}" in ${target.label}, left unchanged`,
      );
    }

    const twin = plan.added.find((entry) => namespace(entry.name) === namespace(name));

    if (twin) {
      return skip(`pi treats it as the same server as "${twin.name}", imported above`);
    }

    const converted = convertServer(source, candidate.raw, context);

    if ("skip" in converted) {
      return skip(converted.skip);
    }

    const notes = candidate.note ? [...converted.notes, candidate.note] : converted.notes;

    return { ...plan, added: [...plan.added, { name, origin, server: converted.server, notes }] };
  };

  const plan = candidates.reduce<Plan>(step, { added: [], skipped: [] });

  return plan.added.length > 0 ? { ...plan, text: mergeText(parsed, plan.added) } : plan;
};
