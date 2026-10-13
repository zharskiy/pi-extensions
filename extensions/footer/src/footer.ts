import type { Host, WidgetHandle } from "../../../core/adapter/contract.ts";
import { parseTotals, type SpendingTotals, TOTALS_CHANNEL } from "../../../core/manager/channels.ts";
import { renderFooter } from "./render.ts";

const CYCLE_BINDING = "app.thinking.cycle";

export const createFooter = (host: Host) => {
  let totals: SpendingTotals | undefined;
  let footer: WidgetHandle | undefined;

  const refresh = () => {
    footer?.refresh();
  };

  host.subscribe(TOTALS_CHANNEL, (data) => {
    const parsed = parseTotals(data);

    if (!parsed) {
      return;
    }

    totals = parsed;
    refresh();
  });

  host.onSessionStart((info) => {
    const cycleKey = host.ui.keyText(CYCLE_BINDING);

    footer = host.ui.setFooter((_width, theme, data) =>
      renderFooter(
        theme,
        {
          context: host.context(),
          model: host.model(),
          thinking: host.thinkingLevel(),
          cycleKey,
          cwd: info.cwd,
          sessionName: host.sessionName(),
          totals,
        },
        data,
      ),
    );
  });

  host.onIdle(refresh);
};
