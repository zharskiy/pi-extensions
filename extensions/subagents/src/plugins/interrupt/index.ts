import { errorText } from "../../components/format.ts";
import { stoppableAgents } from "../../components/tree.ts";
import { NAMESPACE } from "../../model/paths.ts";
import type { Plugin } from "../../model/plugin.ts";

const SHOWN_IDS = 3;

const agentCount = (count: number) => `${count} ${count === 1 ? "agent" : "agents"}`;

export const stillRunningText = (ids: string[]) => {
  const shown = ids.slice(0, SHOWN_IDS);
  const more = ids.length - shown.length;
  const names = more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");

  return `${agentCount(ids.length)} ${ids.length === 1 ? "is" : "are"} still running: ${names}.`;
};

export const interruptPlugin: Plugin = {
  id: "interrupt",
  requires: ["agent-registry", "run-agent"],
  enable: ({ host, services }) => {
    const registry = services.require("registry");
    const runner = services.require("runner");
    let armed = false;
    let enabled = true;

    host.onIdle(({ aborted }) => {
      armed = enabled && aborted;
    });

    host.onAgentStart(() => {
      armed = false;
    });

    const confirmAndStop = async (ids: string[]) => {
      const yes = await host.ui.confirm("Stop running agents?", stillRunningText(ids));

      if (!yes) {
        return;
      }

      host.ui.notify(`${NAMESPACE}: stopping ${agentCount(ids.length)}`, "info");
      await Promise.all(ids.map((id) => runner.stop(id)));
    };

    const offEscape = host.ui.onEmptyEditorEscape(() => {
      if (!armed) {
        return false;
      }

      const ids = stoppableAgents(registry.list()).map((record) => record.id);

      if (ids.length === 0) {
        return false;
      }

      armed = false;
      confirmAndStop(ids).catch((error: unknown) => {
        host.ui.notify(`${NAMESPACE}: cannot stop the agents: ${errorText(error)}`, "warning");
      });

      return true;
    });

    return () => {
      enabled = false;
      armed = false;
      offEscape();
    };
  },
};
