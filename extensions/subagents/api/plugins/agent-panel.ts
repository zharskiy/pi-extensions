import type { ThemeLike } from "../../../../platform/pi-adapter/index.ts";
import { errorText, HINT_STATUS_PREFIX } from "../../../../platform/shared/index.ts";
import {
  createPanelState,
  type PanelActionsAvailable,
  panelRows,
  reconcile,
} from "../../core/agent-panel/panel-state.ts";
import { tickFor, watchAgents } from "../../core/components/refresh.ts";
import type { TreeRow } from "../../core/components/tree.ts";
import { NAMESPACE } from "../../core/model/paths.ts";
import type { Plugin } from "../../core/model/plugin.ts";
import { type PanelActions, panelKeyHandler, selectFirst } from "../../ui/agent-panel/keys.ts";
import { createPanelWidget } from "../../ui/agent-panel/panel.ts";
import { panelLines } from "../../ui/agent-panel/panel-lines.ts";

const HINT_KEY = `${HINT_STATUS_PREFIX}subagents`;

export const agentPanelPlugin: Plugin = {
  id: "agent-panel",
  requires: ["agent-registry"],
  enable: ({ host, bus, settings, services }) => {
    const registry = services.require("registry");
    const state = createPanelState();
    let current: TreeRow[] = [];
    let capture: (() => void) | undefined;
    let tui = false;
    let enabled = true;
    let shown: string | undefined;

    const available = (): PanelActionsAvailable => ({
      view: services.has("agentView"),
      stop: services.has("runner"),
    });

    const rows = () => panelRows(registry.list(), Date.now(), settings, state.cleared);

    const render = (width: number, theme: ThemeLike) =>
      panelLines(current, state, Date.now(), width, theme, available());

    const widget = createPanelWidget(host.ui, render);

    const release = () => {
      const remove = capture;

      capture = undefined;
      remove?.();
    };

    const applyHint = (force = false) => {
      const wanted =
        enabled && tui && current.length === 0 && !settings.disabledPlugins.includes("agent-view");
      const value = wanted
        ? `${host.ui.style("dim", "←")} ${host.ui.style("muted", "to list agents")}`
        : undefined;

      if (force ? value === undefined && shown === undefined : value === shown) {
        return;
      }

      shown = value;
      host.ui.setStatus(HINT_KEY, value);
    };

    const refresh = () => {
      current = rows();
      applyHint();

      if (reconcile(current, state)) {
        release();
      }

      if (current.length === 0) {
        widget.hide();

        return;
      }

      widget.show();
    };

    const report = (action: string, error: unknown) => {
      host.ui.notify(`${NAMESPACE}: ${action} failed: ${errorText(error)}`, "warning");
    };

    const actions: PanelActions = {
      rows,
      state,
      refresh,
      view: (id) => {
        if (services.has("agentView")) {
          services
            .require("agentView")
            .open(id)
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

    host.onSessionStart((info) => {
      tui = info.mode === "tui";
      current = rows();
      applyHint(true);
    });

    const offDown = host.ui.onEmptyEditorDown(() => {
      if (selectFirst(actions)) {
        install();
      }
    });

    return () => {
      enabled = false;
      if (shown !== undefined) {
        shown = undefined;
        host.ui.setStatus(HINT_KEY, undefined);
      }

      offDown();
      release();
      unwatch();
      widget.hide();
    };
  },
};
