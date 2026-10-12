import { createThrottle } from "../../components/refresh.ts";
import type { Plugin } from "../../model/plugin.ts";
import { type AgentRecord, isClosed } from "../../model/types.ts";
import { createClosedRowCache, visibleRecords, widgetLines } from "./model.ts";

export const WIDGET_KEY = "pi-subagents-progress";

const TICK_MS = 1_000;

export const progressWidgetPlugin: Plugin = {
  id: "progress-widget",
  requires: ["agent-registry"],
  enable: ({ host, bus, settings, services }) => {
    const registry = services.require("registry");
    let shown = false;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let handle: { refresh(): void } | undefined;
    let shownSignature = "";
    let frame = 0;
    const rowCache = createClosedRowCache();

    const visible = () => visibleRecords(registry.list(), Date.now(), settings);

    const signatureOf = (records: AgentRecord[]) => {
      const allClosed = records.every((record) => isClosed(record.state));

      if (!allClosed) {
        return undefined;
      }

      return records.map((record) => `${record.id}@${record.version}`).join(",");
    };

    const stopTicker = () => {
      if (ticker) {
        clearInterval(ticker);
      }

      ticker = undefined;
    };

    const refresh = () => {
      const rows = visible();

      rowCache.prune(rows);

      if (rows.length === 0) {
        if (shown) {
          host.ui.setWidget(WIDGET_KEY, undefined);
        }

        shown = false;
        shownSignature = "";
        handle = undefined;
        stopTicker();

        return;
      }

      if (!shown) {
        handle = host.ui.setWidget(WIDGET_KEY, (width, theme) =>
          widgetLines(visible(), Date.now(), frame, theme, width, rowCache),
        );
        shown = true;
        shownSignature = "";
      }

      ticker ??= setInterval(refresh, TICK_MS);

      const signature = signatureOf(rows);

      if (signature !== undefined && signature === shownSignature) {
        return;
      }

      shownSignature = signature ?? "";
      frame += 1;
      handle?.refresh();
    };

    const throttled = createThrottle(refresh, () => settings.renderThrottleMs);
    const off = bus.on("agent:changed", () => throttled());

    return () => {
      off();
      throttled.cancel();
      stopTicker();

      if (shown) {
        host.ui.setWidget(WIDGET_KEY, undefined);
      }

      shown = false;
    };
  },
};
