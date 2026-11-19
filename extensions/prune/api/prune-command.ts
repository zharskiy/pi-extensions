import { type Host, PAD, type SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { ELLIPSIS } from "../../../platform/shared/index.ts";
import { MARKS } from "../../../platform/ui-kit/index.ts";
import { INTERVALS, loadDays, NAMESPACE, saveDays } from "../core/settings.ts";
import { apply } from "../core/sweep-apply.ts";
import {
  cutoffAt,
  type Plan,
  plan,
  planAt,
  removesAnything,
  type Sources,
  scan,
  scanInput,
  totals,
  within,
} from "../core/sweep-plan.ts";
import { intervalForm, menuForm } from "../ui/prune-picker.ts";
import {
  ALREADY_OPEN,
  abortedText,
  autoText,
  CONFIRM_TITLE,
  confirmText,
  failedText,
  NO_TERMINAL,
  NOTHING_TEXT,
  outcomeText,
  savedWithErrorsText,
} from "../ui/prune-report.ts";

const SCANNING = "Scanning sessions";

const REMOVING = "Removing old sessions";

const busy = async <T>(host: Host, text: string, work: () => Promise<T>) => {
  host.ui.setWidget(
    NAMESPACE,
    (_width, theme) => [`${PAD}${theme.fg("muted", `${MARKS.pending} ${text}${ELLIPSIS}`)}`],
    { above: true },
  );

  try {
    return await work();
  } finally {
    host.ui.setWidget(NAMESPACE, undefined);
  }
};

export const registerPrune = (host: Host, sources: (info: SessionInfo) => Sources) => {
  let open = false;

  const plans = async (info: SessionInfo) => {
    const now = Date.now();
    const scanned = await scan(await scanInput(sources(info)), cutoffAt(now, INTERVALS[0]));

    return INTERVALS.map((days) => plan(scanned, cutoffAt(now, days)));
  };

  const choose = (info: SessionInfo, days: number) => {
    const failure = saveDays(info, days);

    if (failure) {
      host.ui.notify(`${NAMESPACE}: ${failure}`, "warning");
      return;
    }

    const { errors } = loadDays(info);

    if (errors.length > 0) {
      host.ui.notify(savedWithErrorsText(errors), "warning");
      return;
    }

    host.ui.notify(autoText(days), "info");
  };

  const pruneNow = async (info: SessionInfo, confirmed: Plan, days: number) => {
    const expected = totals(confirmed);
    const outcome = await busy(host, REMOVING, async () => {
      const fresh = await planAt({ ...(await scanInput(sources(info))), days, now: Date.now() });

      return fresh.aborted ?? apply(within(fresh, confirmed), sources(info));
    });

    if (typeof outcome === "string") {
      host.ui.notify(abortedText(outcome), "warning");
      return;
    }

    host.ui.notify(outcomeText(outcome, expected, days), "info");
  };

  const pickPrune = async (info: SessionInfo, planned: readonly Plan[], selected?: number): Promise<void> => {
    const days = await host.ui.showForm(intervalForm("prune", planned, selected));

    if (days === undefined) {
      return menu(info, planned);
    }

    const confirmed = planned[INTERVALS.indexOf(days)];
    const expected = totals(confirmed);

    if (!removesAnything(expected)) {
      return pickPrune(info, planned, days);
    }

    const skipped = confirmed.handoffsSkipped ? sources(info).handoffRoot : undefined;

    if (!(await host.ui.confirm(CONFIRM_TITLE, confirmText(expected, days, skipped)))) {
      return pickPrune(info, planned, days);
    }

    await pruneNow(info, confirmed, days);
  };

  const menu = async (info: SessionInfo, planned: readonly Plan[]): Promise<void> => {
    const stored = loadDays(info);
    const configured = stored.errors.length === 0 ? stored.settings.days : undefined;
    const kind = await host.ui.showForm(menuForm(planned, configured));

    if (kind === undefined || (kind === "prune" && planned[0].aborted)) {
      return;
    }

    if (kind === "prune" && !removesAnything(totals(planned[0]))) {
      host.ui.notify(NOTHING_TEXT, "info");
      return;
    }

    if (kind === "prune") {
      return pickPrune(info, planned, configured);
    }

    const days = await host.ui.showForm(intervalForm(kind, planned, configured));

    if (days === undefined) {
      return menu(info, planned);
    }

    choose(info, days);
  };

  const run = async (info: SessionInfo) => {
    const planned = await busy(host, SCANNING, () => plans(info));

    if (planned[0].aborted) {
      host.ui.notify(abortedText(planned[0].aborted), "warning");
    }

    await menu(info, planned);
  };

  host.registerCommand("prune", {
    description: "Remove old sessions now or set automatic pruning",
    run: async () => {
      const info = host.session();

      if (info.mode !== "tui") {
        host.ui.notify(NO_TERMINAL, "info");
        return;
      }

      if (open) {
        host.ui.notify(ALREADY_OPEN, "info");
        return;
      }

      open = true;

      try {
        await run(info);
      } catch (error) {
        host.ui.notify(failedText(error), "warning");
      } finally {
        open = false;
      }
    },
  });
};
