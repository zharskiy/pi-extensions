import type { ThemeLike, WidgetHandle } from "../../../../../core/adapter/contract.ts";
import { errorText } from "../../components/format.ts";
import { tickFor, watchAgents } from "../../components/refresh.ts";
import type { TreeRow } from "../../components/tree.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type PanelActions, panelKeyHandler, selectFirst } from "./keys.ts";
import { createPanelState, type PanelActionsAvailable, panelLines, panelRows, reconcile } from "./model.ts";

const WIDGET_KEY = "pi-subagents-agents";

export const agentPanelPlugin: Plugin = {
  id: "agent-panel",
  requires: ["agent-registry"],
  enable: ({ host, bus, settings, services }) => {
    const registry = services.require("registry");
    const state = createPanelState();
    let current: TreeRow[] = [];
    let handle: WidgetHandle | undefined;
    let capture: (() => void) | undefined;

    const available = (): PanelActionsAvailable => ({
      view: services.has("agentView"),
      stop: services.has("runner"),
    });

    const rows = () => panelRows(registry.list(), Date.now(), settings, state.cleared);

    const render = (width: number, theme: ThemeLike) =>
      panelLines(current, state, Date.now(), width, theme, available());

    const release = () => {
      const remove = capture;

      capture = undefined;
      remove?.();
    };

    const refresh = () => {
      current = rows();

      if (reconcile(current, state)) {
        release();
      }

      if (current.length === 0) {
        if (handle) {
          host.ui.setWidget(WIDGET_KEY, undefined);
        }

        handle = undefined;

        return;
      }

      handle ??= host.ui.setWidget(WIDGET_KEY, render);
      handle.refresh();
    };

    const report = (action: string, error: unknown) => {
      host.ui.notify(`pi-subagents: ${action} failed: ${errorText(error)}`, "warning");
    };

    const actions: PanelActions = {
      rows,
      state,
      refresh,
      view: (id) => {
        if (services.has("agentView")) {
          services
            .require("agentView")
            .open(id, { from: "panel" })
            .catch((error: unknown) => report("open", error));
        }
      },
      stop: (id) => {
        if (services.has("runner")) {
          services
            .require("runner")
            .stop(id)
            .catch((error: unknown) => report("stop", error));
        }
      },
      release,
    };

    const install = () => {
      release();
      capture = host.ui.captureEditorKeys(panelKeyHandler(actions));
    };

    const unwatch = watchAgents(bus, {
      relevant: () => true,
      tickMs: () =>
        tickFor(
          current.map((row) => row.record),
          true,
        ),
      throttleMs: () => settings.renderThrottleMs,
      onChange: refresh,
    });

    const offDown = host.ui.onEmptyEditorDown(() => {
      if (selectFirst(actions)) {
        install();
      }
    });

    return () => {
      offDown();
      release();
      unwatch();

      if (handle) {
        host.ui.setWidget(WIDGET_KEY, undefined);
        handle = undefined;
      }
    };
  },
};
