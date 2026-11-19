import { counted } from "../../../platform/shared/index.ts";
import { INTERVALS } from "../core/command-args.ts";
import { MAX_DAYS, NAMESPACE, SETTINGS_FILE } from "../core/settings.ts";
import type { Removed } from "../core/sweep-apply.ts";
import type { KeepReason, Plan, Stem } from "../core/sweep-plan.ts";

const REASONS: KeepReason[] = ["fresh", "live", "parent"];

export const USAGE = `${NAMESPACE}: usage /prune [<days>] [apply], <days> a whole number from ${INTERVALS[0]} to ${MAX_DAYS}`;

export const OFF_TEXT = `${NAMESPACE}: off, days is 0; /prune <days> shows what <days> would remove`;

export const NOTHING_TEXT = `${NAMESPACE}: nothing to remove at any interval`;

export const CONFIRM_TITLE = "Remove old sessions?";

const amounts = (removed: Removed) =>
  [
    [removed.sessions, "session"],
    [removed.runs, "agent run"],
    [removed.handoffs, "handoff dir"],
  ] as const;

const listed = (pairs: readonly (readonly [number, string])[]) =>
  pairs.map(([count, word]) => counted(count, word)).join(", ");

export const daysText = (days: number) => counted(days, "day");

const nonzero = (removed: Removed) => amounts(removed).filter(([count]) => count > 0);

export const countsText = (removed: Removed) => {
  const parts = nonzero(removed);

  return parts.length > 0 ? listed(parts) : "nothing to remove";
};

export const confirmText = (removed: Removed, days: number) =>
  `Remove ${listed(nonzero(removed))} not touched for ${daysText(days)}? Sessions open in a pi process without prune are judged by age alone. This cannot be undone.`;

export const removedText = (removed: Removed, days: number) => {
  const parts = nonzero(removed);

  return parts.length > 0
    ? `${NAMESPACE}: removed ${listed(parts)} older than ${daysText(days)}`
    : `${NAMESPACE}: nothing older than ${daysText(days)} to remove`;
};

export const abortedText = (reason: string) => `${NAMESPACE}: nothing removed, ${reason}`;

export const settingsText = (errors: readonly string[]) =>
  [
    `${NAMESPACE}: off until ${SETTINGS_FILE} loads without errors:`,
    ...errors.map((error) => `  ${error}`),
  ].join("\n");

const runCount = (stems: readonly Stem[]) => stems.reduce((sum, stem) => sum + stem.runs.length, 0);

export const plannedCounts = (plan: Plan): Removed => ({
  sessions: plan.sessions.length,
  runs: runCount(plan.sessions.flatMap((session) => session.stem ?? [])) + runCount(plan.orphans.stems),
  handoffs: plan.sessions.filter((session) => session.handoff).length + plan.orphans.handoffs.length,
});

export const planReport = (plan: Plan, days: number, handoffRoot: string) => {
  if (plan.aborted) {
    return abortedText(plan.aborted);
  }

  const kept = REASONS.map(
    (reason) => `${plan.kept.filter((session) => session.reason === reason).length} ${reason}`,
  );

  const unreadable = plan.unreadable.map((file) => `  ${file}`);

  return [
    `${NAMESPACE}: ${daysText(days)}, cutoff ${new Date(plan.cutoff).toISOString()}`,
    `would remove: ${listed(amounts(plannedCounts(plan)))}`,
    `keeps: ${counted(plan.kept.length, "session")} (${kept.join(", ")})`,
    ...(unreadable.length > 0 ? ["unreadable, never removed:", ...unreadable] : []),
    ...(plan.handoffsSkipped
      ? [`handoff dirs skipped: ${handoffRoot} is not a directory of yours closed to others`]
      : []),
  ].join("\n");
};
