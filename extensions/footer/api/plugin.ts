import type { WidgetHandle } from "../../../platform/pi-adapter/index.ts";
import {
  LIMITS_CHANNEL,
  type Plugin,
  parseLimits,
  parseTotals,
  TOTALS_CHANNEL,
} from "../../../platform/shared/index.ts";
import { footerState } from "../core/segments.ts";
import { watchChannel } from "../core/status.ts";
import { renderFooter } from "../ui/render.ts";

const CYCLE_BINDING = "app.thinking.cycle";

export const footerPlugin: Plugin<never, never, undefined> = {
  id: "footer",
  enable({ host }) {
    let footer: WidgetHandle | undefined;

    const refresh = () => {
      footer?.refresh();
    };

    const totals = watchChannel(host, TOTALS_CHANNEL, parseTotals, refresh);
    const limits = watchChannel(host, LIMITS_CHANNEL, parseLimits, refresh);

    host.onSessionStart((info) => {
      const cycleKey = host.ui.keyText(CYCLE_BINDING);

      footer = host.ui.setFooter((width, theme, data) =>
        renderFooter(theme, footerState(host, info.cwd, cycleKey, totals(), limits()), data, width),
      );
    });

    host.onIdle(refresh);

    return undefined;
  },
};
