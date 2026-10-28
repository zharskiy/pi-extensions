import { counted, errorText } from "../../../../platform/shared/index.ts";
import { stoppableAgents } from "../../core/components/tree.ts";
import { NAMESPACE } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";

const SHOWN_IDS = 3;

const stillRunningText = (ids: string[]) => {
  const shown = ids.slice(0, SHOWN_IDS);
  const more = ids.length - shown.length;
  const names = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");

  return `${counted(ids.length, "agent")} ${ids.length === 1 ? "is" : "are"} still running: ${names}.`;
};

export const interruptPlugin: Plugin = {
  id: "interrupt",
  requires: ["agent-registry", "run-agent"],
  enable: ({ host, services }) => {
    const registry = services.require("registry");
    const runner = services.require("runner");

    const confirmAndStop = async (ids: string[]) => {
      const yes = await host.ui.confirm("Stop running agents?", stillRunningText(ids));

      if (!yes) {
        return;
      }

      host.ui.notify(`${NAMESPACE}: stopping ${counted(ids.length, "agent")}`, "info");
      await Promise.all(ids.map((id) => runner.stop(id)));
    };

    return host.ui.onEmptyEditorEscape(() => {
      const ids = stoppableAgents(registry.list()).map((record) => record.id);

      if (ids.length === 0) {
        return false;
      }

      confirmAndStop(ids).catch((error: unknown) => {
        host.ui.notify(`${NAMESPACE}: cannot stop the agents: ${errorText(error)}`, "warning");
      });

      return true;
    });
  },
};
