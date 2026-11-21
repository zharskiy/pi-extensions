import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";
import { claimMarker, readLive, releaseMarker } from "../core/live-markers.ts";
import { sweep } from "../core/prune.ts";
import type { PruneSettings } from "../core/settings.ts";
import { itemsOf } from "../core/sweep-plan.ts";
import type { Sources } from "../core/sweep-scan.ts";
import { abortedText, removedText, sweepFailedText } from "../ui/prune-report.ts";
import { registerPrune } from "./prune-command.ts";

export type PruneDeps = {
  handoffRoot: string;
  isAlive: (pid: number) => boolean;
  process: { swept: boolean; marker?: string };
};

export const prunePlugin = (deps: PruneDeps): Plugin<never, never, PruneSettings> => ({
  id: "prune",
  enable({ host, settings, settingsErrors }) {
    const sources = (info: SessionInfo): Sources => ({
      agentDir: info.agentDir,
      handoffRoot: deps.handoffRoot,
      live: () => readLive(info, deps.isAlive),
    });

    const autoSweep = async (info: SessionInfo) => {
      const outcome = await sweep(sources(info), settings.days, Date.now());

      if (typeof outcome === "string") {
        host.ui.notify(abortedText(outcome), "warning");
        return;
      }

      if (itemsOf(outcome.removed) > 0 || outcome.empties > 0) {
        host.ui.notify(removedText(outcome.removed, settings.days, outcome.empties), "info");
      }
    };

    host.onSessionStart((info) => {
      const failure = claimMarker(deps.process, info);

      if (deps.process.swept) {
        return;
      }

      deps.process.swept = true;

      if (settings.days === 0 || settingsErrors().length > 0) {
        return;
      }

      if (failure) {
        host.ui.notify(abortedText(failure), "warning");
        return;
      }

      autoSweep(info)
        .catch((error: unknown) => {
          host.ui.notify(sweepFailedText(error), "warning");
        })
        .catch(() => undefined);
    });

    host.onSessionShutdown((reason) => {
      if (reason === "quit") {
        releaseMarker(deps.process);
      }
    });

    registerPrune(host, sources);

    return undefined;
  },
});
