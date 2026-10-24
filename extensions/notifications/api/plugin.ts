import { AWAITING_INPUT_CHANNEL, BUSY_CHANNEL, type Plugin } from "../../../shared/index.ts";
import { createNotifier } from "../core/notifications.ts";
import type { NotificationSettings } from "../core/settings.ts";

export const notificationsPlugin: Plugin<never, never, NotificationSettings> = {
  id: "notifications",
  enable({ host, settings }) {
    let offKeys: (() => void) | undefined;

    const notifier = createNotifier(settings, (text, channel) => host.ui.terminalNotify(text, channel));

    host.onSessionStart((info) => {
      const active = notifier.start(info.mode);

      if (active && !offKeys) {
        offKeys = host.ui.onKeyPress(notifier.key);
      }
    });

    host.subscribe(BUSY_CHANNEL, notifier.busy);

    host.onIdle(notifier.settled);

    host.onAgentStart(notifier.agentStart);

    host.onDialog(notifier.dialog);

    host.subscribe(AWAITING_INPUT_CHANNEL, notifier.awaiting);

    host.onSessionShutdown(() => {
      notifier.shutdown();
      offKeys?.();
      offKeys = undefined;
    });

    return undefined;
  },
};
