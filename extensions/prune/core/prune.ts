import { INTERVALS } from "./settings.ts";
import { apply, clearEmpties } from "./sweep-apply.ts";
import { cutoffAt, type Plan, plan, within } from "./sweep-plan.ts";
import { type Sources, scan } from "./sweep-scan.ts";

export const planIntervals = async (sources: Sources, now: number) => {
  const scanned = await scan(sources, cutoffAt(now, INTERVALS[0]), now);

  return typeof scanned === "string" ? scanned : INTERVALS.map((days) => plan(scanned, cutoffAt(now, days)));
};

export const pruneConfirmed = async (sources: Sources, confirmed: Plan, days: number, now: number) => {
  const cutoff = cutoffAt(now, days);
  const scanned = await scan(sources, cutoff, now);

  return typeof scanned === "string"
    ? scanned
    : apply(within(plan(scanned, cutoff), confirmed), sources.live, sources.handoffRoot);
};

export const sweep = async (sources: Sources, days: number, now: number) => {
  const cutoff = cutoffAt(now, days);
  const scanned = await scan(sources, cutoff, now);

  if (typeof scanned === "string") {
    return scanned;
  }

  const removed = await apply(plan(scanned, cutoff), sources.live, sources.handoffRoot);
  const empties = await clearEmpties(scanned.empties, sources.live, sources.handoffRoot);

  return { removed, empties };
};
