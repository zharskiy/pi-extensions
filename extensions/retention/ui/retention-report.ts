import { counted } from "../../../platform/shared/index.ts";
import type { Removed } from "../core/sweep-apply.ts";
import type { KeepReason, Plan, Stem } from "../core/sweep-plan.ts";

const LABEL = "retention";

const REASONS: KeepReason[] = ["fresh", "live", "parent"];

export const USAGE = `${LABEL}: usage /retention [apply]`;

export const OFF_TEXT = `${LABEL}: off, retentionDays is 0`;

const amounts = (removed: Removed) =>
  [
    [removed.sessions, "session"],
    [removed.runs, "agent run"],
    [removed.handoffs, "handoff dir"],
  ] as const;

const listed = (pairs: readonly (readonly [number, string])[]) =>
  pairs.map(([count, word]) => counted(count, word)).join(", ");

const days = (retentionDays: number) => counted(retentionDays, "day");

export const removedText = (removed: Removed, retentionDays: number) => {
  const parts = amounts(removed).filter(([count]) => count > 0);

  return parts.length > 0
    ? `${LABEL}: removed ${listed(parts)} older than ${days(retentionDays)}`
    : `${LABEL}: nothing older than ${days(retentionDays)} to remove`;
};

export const settingsText = (errors: readonly string[]) =>
  [
    `${LABEL}: off until pi-retention.json loads without errors:`,
    ...errors.map((error) => `  ${error}`),
  ].join("\n");

const runCount = (stems: readonly Stem[]) => stems.reduce((sum, stem) => sum + stem.runs.length, 0);

const plannedCounts = (plan: Plan): Removed => ({
  sessions: plan.sessions.length,
  runs: runCount(plan.sessions.flatMap((session) => session.stem ?? [])) + runCount(plan.orphans.stems),
  handoffs: plan.sessions.filter((session) => session.handoff).length + plan.orphans.handoffs.length,
});

export const planReport = (plan: Plan, retentionDays: number, handoffRoot: string) => {
  if (plan.aborted) {
    return `${LABEL}: aborted, nothing would be removed: ${plan.aborted}`;
  }

  const kept = REASONS.map(
    (reason) => `${plan.kept.filter((session) => session.reason === reason).length} ${reason}`,
  );

  const unreadable = plan.unreadable.map((file) => `  ${file}`);

  return [
    `${LABEL}: ${days(retentionDays)}, cutoff ${new Date(plan.cutoff).toISOString()}`,
    `would remove: ${listed(amounts(plannedCounts(plan)))}`,
    `keeps: ${counted(plan.kept.length, "session")} (${kept.join(", ")})`,
    ...(unreadable.length > 0 ? ["unreadable, never removed:", ...unreadable] : []),
    ...(plan.handoffsSkipped
      ? [`handoff dirs skipped: ${handoffRoot} is not a directory of yours closed to others`]
      : []),
  ].join("\n");
};
