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
  removedText,
  savedWithErrorsText,
} from "../ui/prune-report.ts";

const SCANNING = "Scanning sessions";

const REMOVING = "Removing old sessions";

const busy = async <T>(host: Host, text: string, work: () => Promise<T>) => {
  host.ui.setWidget(NAMESPACE, (_width, theme) => [
    `${PAD}${theme.fg("muted", `${MARKS.pending} ${text}${ELLIPSIS}`)}`,
  ]);

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
    const planned = totals(confirmed);

    if (!removesAnything(planned)) {
      host.ui.notify(removedText(planned, days), "info");
      return;
    }

    const skipped = confirmed.handoffsSkipped ? sources(info).handoffRoot : undefined;

    if (!(await host.ui.confirm(CONFIRM_TITLE, confirmText(planned, days, skipped)))) {
      return;
    }

    const outcome = await busy(host, REMOVING, async () => {
      const fresh = await planAt({ ...(await scanInput(sources(info))), days, now: Date.now() });

      return fresh.aborted ?? apply(within(fresh, confirmed), sources(info));
    });

    if (typeof outcome === "string") {
      host.ui.notify(abortedText(outcome), "warning");
      return;
    }

    host.ui.notify(removedText(outcome, days), "info");
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

    const days = await host.ui.showForm(intervalForm(kind, planned, configured));

    if (days === undefined) {
      return menu(info, planned);
    }

    if (kind === "auto") {
      choose(info, days);
      return;
    }

    await pruneNow(info, planned[INTERVALS.indexOf(days)], days);
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
