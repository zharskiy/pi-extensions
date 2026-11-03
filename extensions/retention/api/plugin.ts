import { join } from "node:path";
import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";
import { markerPath, removeMarker, writeMarker } from "../core/live-markers.ts";
import { subdirsIn } from "../core/real-dirs.ts";
import type { RetentionSettings } from "../core/settings.ts";
import { apply } from "../core/sweep-apply.ts";
import { plan } from "../core/sweep-plan.ts";
import { OFF_TEXT, planReport, removedText, settingsText, USAGE } from "../ui/retention-report.ts";

export type RetentionDeps = {
  handoffRoot: string;
  isAlive: (pid: number) => boolean;
  process: { swept: boolean; marker?: string };
};

const APPLY = "apply";

export const retentionPlugin = (deps: RetentionDeps): Plugin<never, never, RetentionSettings> => ({
  id: "retention",
  enable({ host, settings, settingsErrors }) {
    const context = (info: SessionInfo) => ({
      agentDir: info.agentDir,
      handoffRoot: deps.handoffRoot,
      current: info,
      isAlive: deps.isAlive,
    });

    const planFor = async (info: SessionInfo) =>
      plan({
        ...context(info),
        slugDirs: await subdirsIn(join(info.agentDir, "sessions")),
        retentionDays: settings.retentionDays,
        now: Date.now(),
      });

    const sweep = async (info: SessionInfo) => {
      const removed = await apply(await planFor(info), context(info));

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

      if (written && settings.retentionDays > 0 && settingsErrors().length === 0) {
        sweep(info).catch(() => undefined);
      }
    });

    host.onSessionShutdown((reason) => {
      if (reason !== "quit" || !deps.process.marker) {
        return;
      }

      removeMarker(deps.process.marker);
      deps.process.marker = undefined;
    });

    host.registerCommand("retention", {
      description:
        "Show which old sessions, agent runs and handoff dirs retention would remove: /retention [apply]",
      complete: (prefix) => (APPLY.startsWith(prefix) ? [{ value: APPLY, label: APPLY }] : null),
      run: async (args) => {
        const arg = args.trim();

        if (arg !== "" && arg !== APPLY) {
          host.ui.notify(USAGE, "error");
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

        const info = host.session();
        const planned = await planFor(info);

        if (arg === APPLY) {
          const text = planned.aborted
            ? planReport(planned, settings.retentionDays, deps.handoffRoot)
            : removedText(await apply(planned, context(info)), settings.retentionDays);

          host.ui.notify(text, "info");
          return;
        }

        host.ui.notify(planReport(planned, settings.retentionDays, deps.handoffRoot), "info");
      },
    });

    return undefined;
  },
});
