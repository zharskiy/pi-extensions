import type { Host, SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { planIntervals, pruneConfirmed } from "../core/prune.ts";
import { INTERVALS, loadDays, NAMESPACE, saveDays } from "../core/settings.ts";
import { itemsOf, type Plan, type Removed, totals } from "../core/sweep-plan.ts";
import type { Sources } from "../core/sweep-scan.ts";
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
  progressLine,
  REMOVING,
  SCANNING,
  savedWithErrorsText,
  saveFailedText,
} from "../ui/prune-report.ts";

type Offer = { plans: Plan[]; counts: Removed[] };

const busy = async <T>(host: Host, text: string, work: () => Promise<T>) => {
  host.ui.setWidget(NAMESPACE, progressLine(text), { above: true });

  try {
    return await work();
  } finally {
    host.ui.setWidget(NAMESPACE, undefined);
  }
};

export const registerPrune = (host: Host, sources: (info: SessionInfo) => Sources) => {
  let open = false;

  const choose = (info: SessionInfo, days: number) => {
    const failure = saveDays(info, days);

    if (failure) {
      host.ui.notify(saveFailedText(failure), "warning");
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

    const outcome = await busy(host, REMOVING, () =>
      pruneConfirmed(sources(info), confirmed, days, Date.now()),
    );

    if (typeof outcome === "string") {
      host.ui.notify(abortedText(outcome), "warning");
      return;
    }

    host.ui.notify(outcomeText(outcome, expected, days), "info");
  };

  const pickPrune = async (info: SessionInfo, offer: Offer, selected?: number): Promise<void> => {
    const days = await host.ui.showForm(intervalForm("prune", offer.counts, selected));

    if (days === undefined) {
      return menu(info, offer);
    }

    const index = INTERVALS.indexOf(days);
    const confirmed = offer.plans[index];
    const expected = offer.counts[index];

    if (itemsOf(expected) === 0) {
      return pickPrune(info, offer, days);
    }

    if (!(await host.ui.confirm(CONFIRM_TITLE, confirmText(expected, days, confirmed.skipped)))) {
      return pickPrune(info, offer, days);
    }

    await pruneNow(info, confirmed, days);
  };

  const menu = async (info: SessionInfo, offer: Offer | undefined): Promise<void> => {
    const stored = loadDays(info);
    const configured = stored.errors.length === 0 ? stored.settings.days : undefined;
    const kind = await host.ui.showForm(menuForm(offer?.counts[0], configured));

    if (kind === undefined) {
      return;
    }

    if (kind === "prune" && offer && itemsOf(offer.counts[0]) === 0) {
      host.ui.notify(NOTHING_TEXT, "info");
      return;
    }

    if (kind === "prune") {
      return offer && pickPrune(info, offer, configured);
    }

    const days = await host.ui.showForm(intervalForm(kind, offer?.counts ?? [], configured));

    if (days === undefined) {
      return menu(info, offer);
    }

    choose(info, days);
  };

  const run = async (info: SessionInfo) => {
    const plans = await busy(host, SCANNING, () => planIntervals(sources(info), Date.now()));

    if (typeof plans === "string") {
      host.ui.notify(abortedText(plans), "warning");
      await menu(info, undefined);
      return;
    }

    await menu(info, { plans, counts: plans.map(totals) });
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
