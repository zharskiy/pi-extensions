import type { SessionInfo } from "../../../platform/pi-adapter/index.ts";
import { errorText, type Plugin } from "../../../platform/shared/index.ts";
import { liveDir, markerPath, removeMarker, writeMarker } from "../core/live-markers.ts";
import { NAMESPACE, type PruneSettings } from "../core/settings.ts";
import { apply, clearEmpties } from "../core/sweep-apply.ts";
import { planAt, removesAnything, scanInput } from "../core/sweep-plan.ts";
import { abortedText, removedText } from "../ui/prune-report.ts";
import { registerPrune } from "./prune-command.ts";

export type PruneDeps = {
  handoffRoot: string;
  isAlive: (pid: number) => boolean;
  process: { swept: boolean; marker?: string };
};

export const prunePlugin = (deps: PruneDeps): Plugin<never, never, PruneSettings> => ({
  id: "prune",
  enable({ host, settings, settingsErrors }) {
    const sources = (info: SessionInfo) => ({
      agentDir: info.agentDir,
      handoffRoot: deps.handoffRoot,
      current: info,
      isAlive: deps.isAlive,
    });

    const sweep = async (info: SessionInfo) => {
      const planned = await planAt({
        ...(await scanInput(sources(info))),
        days: settings.days,
        now: Date.now(),
      });

      if (planned.aborted) {
        host.ui.notify(abortedText(planned.aborted), "warning");
        return;
      }

      const removed = await apply(planned, sources(info));
      const empties = await clearEmpties(planned, sources(info));

      if (removesAnything(removed) || empties > 0) {
        host.ui.notify(removedText(removed, settings.days, empties), "info");
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

      if (settings.days === 0 || settingsErrors().length > 0) {
        return;
      }

      if (!written) {
        host.ui.notify(abortedText(`${liveDir(info.agentDir)}: cannot write the liveness marker`), "warning");
        return;
      }

      sweep(info)
        .catch((error: unknown) => {
          host.ui.notify(`${NAMESPACE}: sweep failed, ${errorText(error)}`, "warning");
        })
        .catch(() => undefined);
    });

    host.onSessionShutdown((reason) => {
      if (reason !== "quit" || !deps.process.marker) {
        return;
      }

      removeMarker(deps.process.marker);
      deps.process.marker = undefined;
    });

    registerPrune(host, sources);

    return undefined;
  },
});
