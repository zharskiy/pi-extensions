import type { WidgetHandle } from "../../../pi-adapter/index.ts";
import type { Plugin } from "../../../shared/index.ts";
import { footerState } from "../core/segments.ts";
import { watchTotals } from "../core/status.ts";
import { renderFooter } from "../ui/render.ts";

const CYCLE_BINDING = "app.thinking.cycle";

export const footerPlugin: Plugin<never, never, undefined> = {
  id: "footer",
  enable({ host }) {
    let footer: WidgetHandle | undefined;

    const refresh = () => {
      footer?.refresh();
    };

    const totals = watchTotals(host, refresh);

    host.onSessionStart((info) => {
      const cycleKey = host.ui.keyText(CYCLE_BINDING);

      footer = host.ui.setFooter((width, theme, data) =>
        renderFooter(theme, footerState(host, info.cwd, cycleKey, totals()), data, width),
      );
    });

    host.onIdle(refresh);

    return undefined;
  },
};
