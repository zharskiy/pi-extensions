import { PAD, type RowLines } from "../../../platform/pi-adapter/index.ts";
import { ELLIPSIS, errorText, noun } from "../../../platform/shared/index.ts";
import { MARKS } from "../../../platform/ui-kit/index.ts";
import { NAMESPACE, SETTINGS_FILE } from "../core/settings.ts";
import { itemsOf, type Removed } from "../core/sweep-plan.ts";

export const NO_TERMINAL = `${NAMESPACE}: /prune needs the interactive terminal; days in ${SETTINGS_FILE} sets automatic pruning`;

export const ALREADY_OPEN = `${NAMESPACE}: /prune is already open`;

export const NOTHING_TEXT = `${NAMESPACE}: nothing to remove at any interval`;

export const CONFIRM_TITLE = "Prune sessions?";

export const SCANNING = "Scanning sessions";

export const REMOVING = "Removing old sessions";

export const progressLine =
  (text: string): RowLines =>
  (_width, theme) => [`${PAD}${theme.fg("muted", `${MARKS.pending} ${text}${ELLIPSIS}`)}`];

const GROUPED = new Intl.NumberFormat("en-US");

const counted = (count: number, word: string) => `${GROUPED.format(count)} ${noun(count, word)}`;

const listed = (pairs: readonly (readonly [number, string])[]) =>
  pairs.map(([count, word]) => counted(count, word)).join(", ");

export const daysText = (days: number) => counted(days, "day");

const parts = (removed: Removed) =>
  (
    [
      [removed.sessions, "session"],
      [removed.runs, "agent run"],
      [removed.handoffs, "handoff dir"],
    ] as const
  ).filter(([count]) => count > 0);

const countsText = (removed: Removed) => {
  const found = parts(removed);

  return found.length > 0 ? listed(found) : "nothing to remove";
};

const UNITS = ["kB", "MB", "GB", "TB"];

export const bytesText = (bytes: number) => {
  if (bytes < 1000) {
    return `${bytes} B`;
  }

  const scaled = (exponent: number): string => {
    const value = (bytes / 1000 ** exponent).toFixed(1);

    return Number(value) >= 1000 && exponent < UNITS.length
      ? scaled(exponent + 1)
      : `${value} ${UNITS[exponent - 1]}`;
  };

  return scaled(1);
};

export const rowText = (removed: Removed) =>
  removed.bytes > 0 ? `${countsText(removed)}, ${bytesText(removed.bytes)}` : countsText(removed);

export const confirmText = (removed: Removed, days: number, skippedRoot?: string) =>
  [
    `Remove ${countsText(removed)}${removed.bytes > 0 ? ` (${bytesText(removed.bytes)})` : ""} not touched for ${daysText(days)}?`,
    "A session open in a pi without this extension may still be removed if it is old.",
    ...(skippedRoot ? [`Handoff dirs are skipped: ${skippedRoot} is open to other users.`] : []),
    "This cannot be undone.",
  ].join(" ");

export const removedText = (removed: Removed, days: number, empties = 0) => {
  const found = parts(removed);
  const aged = found.length > 0 ? [`${listed(found)} older than ${daysText(days)}`] : [];
  const cleared = empties > 0 ? [listed([[empties, "empty handoff dir"]])] : [];
  const freed = removed.bytes > 0 ? `, ${bytesText(removed.bytes)} freed` : "";

  return aged.length + cleared.length > 0
    ? `${NAMESPACE}: removed ${[...aged, ...cleared].join(", ")}${freed}`
    : `${NAMESPACE}: nothing older than ${daysText(days)} to remove`;
};

export const outcomeText = (removed: Removed, expected: Removed, days: number) => {
  if (itemsOf(removed) === 0) {
    return `${NAMESPACE}: nothing removed, the sessions changed since the scan`;
  }

  const text = removedText(removed, days);

  return itemsOf(removed) < itemsOf(expected)
    ? `${text}, the rest changed since the scan and was kept`
    : text;
};

export const abortedText = (reason: string) => `${NAMESPACE}: nothing removed, ${reason}`;

export const failedText = (error: unknown) => `${NAMESPACE}: prune failed, ${errorText(error)}`;

export const sweepFailedText = (error: unknown) => `${NAMESPACE}: sweep failed, ${errorText(error)}`;

export const saveFailedText = (failure: string) => `${NAMESPACE}: ${failure}`;

export const autoText = (days: number) =>
  days > 0
    ? `${NAMESPACE}: sessions not touched for ${daysText(days)} are now removed when pi starts`
    : `${NAMESPACE}: automatic pruning is off`;

export const savedWithErrorsText = (errors: readonly string[]) =>
  [
    `${NAMESPACE}: saved, but automatic pruning stays off until ${SETTINGS_FILE} loads without errors:`,
    ...errors.map((error) => `  ${error}`),
  ].join("\n");
