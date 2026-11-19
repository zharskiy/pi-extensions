import { join } from "node:path";
import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { errorText, type Plugin } from "../../../platform/shared/index.ts";
import { completeArgs, INTERVALS, parseArgs } from "../core/command-args.ts";
import { liveDir, markerPath, removeMarker, writeMarker } from "../core/live-markers.ts";
import { subdirsIn } from "../core/real-dirs.ts";
import { NAMESPACE, type RetentionSettings } from "../core/settings.ts";
import { apply, type Removed } from "../core/sweep-apply.ts";
import { cutoffAt, plan, planAt, scan, within } from "../core/sweep-plan.ts";
import { pickInterval } from "../ui/interval-pick.ts";
import {
  abortedText,
  CONFIRM_TITLE,
  confirmText,
  NOTHING_TEXT,
  OFF_TEXT,
  plannedCounts,
  planReport,
  removedText,
  settingsText,
  USAGE,
} from "../ui/retention-report.ts";

export type RetentionDeps = {
  handoffRoot: string;
  isAlive: (pid: number) => boolean;
  process: { swept: boolean; marker?: string };
};

const total = (counts: Removed) => counts.sessions + counts.runs + counts.handoffs;

export const retentionPlugin = (deps: RetentionDeps): Plugin<never, never, RetentionSettings> => ({
  id: "retention",
  enable({ host, settings, settingsErrors }) {
    const context = (info: SessionInfo) => ({
      agentDir: info.agentDir,
      handoffRoot: deps.handoffRoot,
      current: info,
      isAlive: deps.isAlive,
    });

    const scanInput = async (info: SessionInfo) => ({
      ...context(info),
      slugDirs: await subdirsIn(join(info.agentDir, "sessions")),
    });

    const planFor = async (info: SessionInfo, retentionDays: number) =>
      planAt({ ...(await scanInput(info)), retentionDays, now: Date.now() });

    const sweep = async (info: SessionInfo) => {
      const planned = await planFor(info, settings.retentionDays);

      if (planned.aborted) {
        host.ui.notify(abortedText(planned.aborted), "warning");
        return;
      }

      const removed = await apply(planned, context(info));

      if (removed.sessions + removed.runs + removed.handoffs > 0) {
        host.ui.notify(removedText(removed, settings.retentionDays), "info");
      }
    };

    host.onSessionStart((info) => {
      const next = markerPath(info.agentDir, info.id);
      const written = writeMarker(next, info);
      const previous = deps.process.marker;

      if (previous && previous !== next) {
        removeMarker(previous);
      }

      deps.process.marker = written ? next : undefined;

      if (deps.process.swept) {
        return;
      }

      deps.process.swept = true;

      if (settings.retentionDays === 0 || settingsErrors().length > 0) {
        return;
      }

      if (!written) {
        host.ui.notify(abortedText(`${liveDir(info.agentDir)}: cannot write the liveness marker`), "warning");
        return;
      }

      sweep(info).catch((error: unknown) => {
        host.ui.notify(`${NAMESPACE}: sweep failed, ${errorText(error)}`, "warning");
      });
    });

    host.onSessionShutdown((reason) => {
      if (reason !== "quit" || !deps.process.marker) {
        return;
      }

      removeMarker(deps.process.marker);
      deps.process.marker = undefined;
    });

    const report = async (info: SessionInfo, retentionDays: number, applying: boolean) => {
      const planned = await planFor(info, retentionDays);

      if (applying && !planned.aborted) {
        host.ui.notify(removedText(await apply(planned, context(info)), retentionDays), "info");
        return;
      }

      host.ui.notify(planReport(planned, retentionDays, deps.handoffRoot), "info");
    };

    const pick = async (info: SessionInfo) => {
      const now = Date.now();
      const scanned = await scan(await scanInput(info), cutoffAt(now, INTERVALS[0]));

      if ("aborted" in scanned) {
        host.ui.notify(abortedText(scanned.aborted), "warning");
        return;
      }

      const plans = INTERVALS.map((interval) => plan(scanned, cutoffAt(now, interval)));

      if (plans.every((planned) => total(plannedCounts(planned)) === 0)) {
        host.ui.notify(NOTHING_TEXT, "info");
        return;
      }

      const configured = settingsErrors().length === 0 ? settings.retentionDays : undefined;
      const picked = await pickInterval(host, plans, configured);

      if (picked === undefined) {
        return;
      }

      const confirmed = plans[INTERVALS.indexOf(picked)];
      const counts = plannedCounts(confirmed);

      if (total(counts) === 0) {
        host.ui.notify(removedText(counts, picked), "info");
        return;
      }

      if (!(await host.ui.confirm(CONFIRM_TITLE, confirmText(counts, picked)))) {
        return;
      }

      const fresh = await planFor(info, picked);

      if (fresh.aborted) {
        host.ui.notify(abortedText(fresh.aborted), "warning");
        return;
      }

      host.ui.notify(removedText(await apply(within(fresh, confirmed), context(info)), picked), "info");
    };

    host.registerCommand("retention", {
      description: "Show or remove old sessions, agent runs and handoff dirs: /retention [<days>] [apply]",
      complete: completeArgs,
      run: async (args) => {
        const parsed = parseArgs(args);

        if (!parsed) {
          host.ui.notify(USAGE, "error");
          return;
        }

        const info = host.session();

        if (parsed.days !== undefined) {
          await report(info, parsed.days, parsed.apply);
          return;
        }

        if (!parsed.apply && info.mode === "tui") {
          await pick(info);
          return;
        }

        if (settingsErrors().length > 0) {
          host.ui.notify(settingsText(settingsErrors()), "error");
          return;
        }

        if (settings.retentionDays === 0) {
          host.ui.notify(OFF_TEXT, "info");
          return;
        }

        await report(info, settings.retentionDays, parsed.apply);
      },
    });

    return undefined;
  },
});
