import type { Host, WidgetHandle } from "../../../pi-adapter/index.ts";
import { parseTotals, type SpendingTotals, sessionCacheHit, TOTALS_CHANNEL } from "../../../shared/index.ts";
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

    footer = host.ui.setFooter((width, theme, data) =>
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
          cache: sessionCacheHit(host.mainRequestUsage()),
        },
        data,
        width,
      ),
    );
  });

  host.onIdle(refresh);
};
