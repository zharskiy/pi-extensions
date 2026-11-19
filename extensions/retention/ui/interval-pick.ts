import type { Host } from "../../../platform/pi-adapter/index.ts";
import { ELLIPSIS } from "../../../platform/shared/index.ts";
import { MARKS, selectForm } from "../../../platform/ui-kit/index.ts";
import { INTERVALS } from "../core/command-args.ts";
import { defaults } from "../core/settings.ts";
import type { Plan } from "../core/sweep-plan.ts";
import { countsText, days, plannedCounts } from "./retention-report.ts";

export const pickInterval = (host: Host, plans: readonly Plan[], configured: number | undefined) => {
  const options = INTERVALS.map((interval, index) => ({
    value: interval,
    label: days(interval),
    description: countsText(plannedCounts(plans[index])),
    mark: interval === configured ? MARKS.success : undefined,
  }));

  const preselected = INTERVALS.find((interval) => interval === configured) ?? defaults.retentionDays;

  return host.ui.showForm(
    selectForm({
      title: `Remove sessions not touched for${ELLIPSIS}`,
      options,
      selected: INTERVALS.indexOf(preselected),
    }),
  );
};
