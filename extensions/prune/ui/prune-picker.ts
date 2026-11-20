import type { FormFactory } from "../../../platform/pi-adapter/index.ts";
import { ELLIPSIS } from "../../../platform/shared/index.ts";
import { MARKS, type SelectOption, selectForm } from "../../../platform/ui-kit/index.ts";
import { defaults, INTERVALS, SETTINGS_FILE } from "../core/settings.ts";
import { itemsOf, type Removed } from "../core/sweep-plan.ts";
import { bytesText, daysText, rowText } from "./prune-report.ts";

export type PickKind = "prune" | "auto";

const pruneNowText = (most: Removed | undefined) => {
  if (!most) {
    return "cannot scan, see the warning";
  }

  if (itemsOf(most) === 0) {
    return "nothing to remove";
  }

  return most.bytes > 0 ? `remove old sessions, up to ${bytesText(most.bytes)}` : "remove old sessions";
};

const autoText = (configured: number | undefined) => {
  if (configured === undefined) {
    return `off, ${SETTINGS_FILE} has an error`;
  }

  return configured > 0 ? daysText(configured) : "off";
};

export const menuForm = (
  most: Removed | undefined,
  configured: number | undefined,
): FormFactory<PickKind | undefined> =>
  selectForm<PickKind>({
    title: "Prune sessions",
    options: [
      { value: "prune", label: "Prune now", description: pruneNowText(most) },
      { value: "auto", label: "Auto-prune", description: autoText(configured) },
    ],
  });

const described = (kind: PickKind, planned: Removed | undefined) => {
  if (!planned) {
    return undefined;
  }

  if (kind === "prune") {
    return rowText(planned);
  }

  return itemsOf(planned) > 0 ? `at next start: ${rowText(planned)}` : undefined;
};

export const intervalForm = (
  kind: PickKind,
  counts: readonly Removed[],
  configured: number | undefined,
): FormFactory<number | undefined> => {
  const rows: SelectOption<number>[] = INTERVALS.map((days, index) => ({
    value: days,
    label: daysText(days),
    description: described(kind, counts[index]),
  }));

  const options = kind === "auto" ? [...rows, { value: 0, label: "Off" }] : rows;
  const marked = options.findIndex((option) => option.value === configured);

  return selectForm({
    title:
      kind === "auto"
        ? `Auto-prune sessions not touched for${ELLIPSIS}`
        : `Remove sessions not touched for${ELLIPSIS}`,
    options: options.map((option, index) =>
      kind === "auto" && index === marked ? { ...option, mark: MARKS.success } : option,
    ),
    selected: marked >= 0 ? marked : INTERVALS.indexOf(defaults.days),
  });
};
