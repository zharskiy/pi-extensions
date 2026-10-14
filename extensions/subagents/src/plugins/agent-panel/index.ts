import type { ThemeLike, WidgetHandle } from "../../../../../core/adapter/contract.ts";
import { watchAgents } from "../../components/refresh.ts";
import type { TreeRow } from "../../components/tree.ts";
import type { Plugin } from "../../model/plugin.ts";
import { isClosed } from "../../model/types.ts";
import { type PanelActions, panelKeyHandler, selectFirst } from "./keys.ts";
import {
  createClosedRowCache,
  createPanelState,
  type PanelActionsAvailable,
  panelLines,
  panelRows,
  reconcile,
} from "./model.ts";

const WIDGET_KEY = "pi-subagents-agents";

const TICK_RUNNING_MS = 100;

const TICK_IDLE_MS = 1_000;

type Rendered = { width: number; theme: ThemeLike; output: string; lines: string[] };

export const agentPanelPlugin: Plugin = {
  id: "agent-panel",
  requires: ["agent-registry"],
  enable: ({ host, bus, settings, services }) => {
    const registry = services.require("registry");
    const state = createPanelState();
    const rowCache = createClosedRowCache();
    let handle: WidgetHandle | undefined;
    let shownSignature = "";
    let rendered: Rendered | undefined;
    let capture: (() => void) | undefined;

    const available = (): PanelActionsAvailable => ({
      view: services.has("agentView"),
      stop: services.has("runner"),
    });

    const rows = () => panelRows(registry.list(), Date.now(), settings, state.cleared);

    const linesFor = (current: TreeRow[], width: number, theme: ThemeLike) =>
      panelLines(current, state, Date.now(), width, theme, rowCache, available());

    const render = (width: number, theme: ThemeLike) => {
      const lines = linesFor(rows(), width, theme);
      const output = lines.join("\n");

      if (rendered && rendered.width === width && rendered.theme === theme && rendered.output === output) {
        return rendered.lines;
      }

      rendered = { width, theme, output, lines };

      return lines;
    };

    const release = () => {
      const remove = capture;

      capture = undefined;
      remove?.();
    };

    const signatureOf = (current: TreeRow[]) =>
      current.every((row) => isClosed(row.record.state))
        ? `${current.map((row) => `${row.record.id}@${row.record.version}`).join(",")}|${state.selectedId}|${state.top}`
        : "";

    const refresh = () => {
      const current = rows();

      rowCache.prune(current);

      if (reconcile(current, state).deselected) {
        release();
      }

      if (current.length === 0) {
        if (handle) {
          host.ui.setWidget(WIDGET_KEY, undefined);
        }

        handle = undefined;
        shownSignature = "";
        rendered = undefined;

        return;
      }

      if (!handle) {
        handle = host.ui.setWidget(WIDGET_KEY, render);
      }

      const signature = signatureOf(current);

      if (signature !== "" && signature === shownSignature) {
        return;
      }

      shownSignature = signature;

      if (rendered) {
        const lines = linesFor(current, rendered.width, rendered.theme);
        const output = lines.join("\n");

        if (output === rendered.output) {
          return;
        }

        rendered = { ...rendered, output, lines };
      }

      handle.refresh();
    };

    const report = (action: string, error: unknown) => {
      host.ui.notify(
        `pi-subagents: ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
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

    const tickMs = () => {
      const current = rows();

      if (current.length === 0) {
        return undefined;
      }

      return current.some((row) => row.record.state === "running" || row.record.state === "grace")
        ? TICK_RUNNING_MS
        : TICK_IDLE_MS;
    };

    const unwatch = watchAgents(bus, {
      relevant: () => true,
      tickMs,
      throttleMs: () => settings.renderThrottleMs,
      onChange: refresh,
    });

    const offLeft = host.ui.onEmptyEditorLeft(() => {
      if (selectFirst(actions)) {
        install();
      }
    });

    return () => {
      offLeft();
      release();
      unwatch();

      if (handle) {
        host.ui.setWidget(WIDGET_KEY, undefined);
        handle = undefined;
      }
    };
  },
};
