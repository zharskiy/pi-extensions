import type { Host, NotifyChannel } from "../../../core/adapter/contract.ts";
import { BUSY_CHANNEL, parseBusySignal } from "../../../core/manager/channels.ts";
import type { NotificationSettings } from "./settings.ts";

const IDLE_TEXT = "pi is waiting for your input";

const dialogText = (title?: string) => (title ? `pi needs your input: ${title}` : "pi needs your input");

const slot = () => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const arm = (run: () => void, ms: number) => {
    clear();
    timer = setTimeout(run, ms);
    timer.unref?.();
  };

  return { arm, clear };
};

export const createNotifications = (host: Host, settings: () => NotificationSettings) => {
  const sources = new Set<string>();
  const idle = slot();
  const dialogTimer = slot();
  let channel: NotifyChannel | undefined;
  let pending = false;
  let dialog: { title?: string; fired: boolean } | undefined;
  let offKeys: (() => void) | undefined;

  const send = (text: string) => channel && host.ui.terminalNotify(text, channel);

  const fireIdle = () => {
    if (dialog) {
      return;
    }

    pending = false;
    send(IDLE_TEXT);
  };

  const fireDialog = () => {
    if (!dialog) {
      return;
    }

    dialog.fired = true;
    send(dialogText(dialog.title));
  };

  const armIdle = () => idle.arm(fireIdle, settings().idleDelayMs);

  const armDialog = () => dialogTimer.arm(fireDialog, settings().dialogDelayMs);

  const key = () => {
    pending = false;
    idle.clear();

    if (dialog && !dialog.fired) {
      armDialog();
    }
  };

  host.onSessionStart((info) => {
    const configured = settings().channel;

    channel = info.mode === "tui" && configured !== "off" ? configured : undefined;

    if (channel && !offKeys) {
      offKeys = host.ui.onKeyPress(key);
    }
  });

  host.subscribe(BUSY_CHANNEL, (data) => {
    const signal = parseBusySignal(data);

    if (!signal) {
      return;
    }

    if (signal.busy) {
      sources.add(signal.source);
      idle.clear();
      return;
    }

    const removed = sources.delete(signal.source);

    if (removed && sources.size === 0 && pending) {
      armIdle();
    }
  });

  host.onIdle(() => {
    if (!channel) {
      return;
    }

    pending = true;

    if (sources.size === 0) {
      armIdle();
    }
  });

  host.onAgentStart(() => {
    pending = false;
    idle.clear();
  });

  host.onDialog((event) => {
    if (event.kind === "custom") {
      return;
    }

    if (event.phase === "start") {
      if (!channel) {
        return;
      }

      dialog = { title: event.title, fired: false };
      armDialog();
      return;
    }

    dialog = undefined;
    dialogTimer.clear();

    if (pending && sources.size === 0) {
      armIdle();
    }
  });

  host.onSessionShutdown(() => {
    channel = undefined;
    pending = false;
    dialog = undefined;
    idle.clear();
    dialogTimer.clear();
    offKeys?.();
    offKeys = undefined;
  });
};
