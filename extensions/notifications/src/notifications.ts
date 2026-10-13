import type { Host, NotifyChannel } from "../../../core/adapter/contract.ts";
import { BUSY_CHANNEL, parseBusySignal } from "../../../core/manager/channels.ts";
import { watchSettings } from "./settings.ts";

export const IDLE_TEXT = "pi is waiting for your input";

export const dialogText = (title?: string) =>
  title ? `pi needs your input: ${title}` : "pi needs your input";

const later = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);

  timer.unref?.();

  return () => clearTimeout(timer);
};

export const createNotifications = (host: Host) => {
  const settings = watchSettings(host);
  const sources = new Set<string>();
  let active = false;
  let channel: NotifyChannel = "auto";
  let pending = false;
  let dialog: { title?: string; fired: boolean } | undefined;
  let idleTimer: (() => void) | undefined;
  let dialogTimer: (() => void) | undefined;
  let offKeys: (() => void) | undefined;

  const send = (text: string) => {
    host.ui.terminalNotify(text, channel);
  };

  const clearIdle = () => {
    idleTimer?.();
    idleTimer = undefined;
  };

  const clearDialog = () => {
    dialogTimer?.();
    dialogTimer = undefined;
  };

  const fireIdle = () => {
    idleTimer = undefined;

    if (!active || !pending || sources.size > 0 || dialog || !host.isIdle()) {
      return;
    }

    pending = false;
    send(IDLE_TEXT);
  };

  const fireDialog = () => {
    dialogTimer = undefined;

    if (!active || !dialog || dialog.fired) {
      return;
    }

    dialog.fired = true;
    send(dialogText(dialog.title));
  };

  const armIdle = () => {
    clearIdle();
    idleTimer = later(fireIdle, settings().idleDelayMs);
  };

  const armDialog = () => {
    clearDialog();
    dialogTimer = later(fireDialog, settings().dialogDelayMs);
  };

  const key = () => {
    pending = false;
    clearIdle();

    if (dialog && !dialog.fired) {
      armDialog();
    }
  };

  host.onSessionStart((info) => {
    const configured = settings().channel;

    active = info.mode === "tui" && configured !== "off";

    if (configured !== "off") {
      channel = configured;
    }

    if (active && !offKeys) {
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
      clearIdle();
      return;
    }

    const removed = sources.delete(signal.source);

    if (removed && sources.size === 0 && pending) {
      armIdle();
    }
  });

  host.onIdle(() => {
    if (!active) {
      return;
    }

    pending = true;

    if (sources.size === 0) {
      armIdle();
    }
  });

  host.onAgentStart(() => {
    pending = false;
    clearIdle();
  });

  host.onDialog((event) => {
    if (event.kind === "custom") {
      return;
    }

    if (event.phase === "start") {
      if (!active) {
        return;
      }

      dialog = { title: event.title, fired: false };
      armDialog();
      return;
    }

    dialog = undefined;
    clearDialog();

    if (pending && sources.size === 0) {
      armIdle();
    }
  });

  host.onSessionShutdown(() => {
    active = false;
    pending = false;
    dialog = undefined;
    clearIdle();
    clearDialog();
    offKeys?.();
    offKeys = undefined;
  });
};
