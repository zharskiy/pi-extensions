import type { Host, NotifyChannel } from "../../../core/adapter/contract.ts";
import {
  AWAITING_INPUT_CHANNEL,
  BUSY_CHANNEL,
  parseAwaitingInput,
  parseBusySignal,
} from "../../../core/manager/channels.ts";
import type { NotificationSettings } from "./settings.ts";

const IDLE_TEXT = "pi is waiting for your input";

const PI_DIALOG = "";

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
  const waits = new Map<string, { title?: string; fired: boolean }>();
  let offKeys: (() => void) | undefined;

  const send = (text: string) => channel && host.ui.terminalNotify(text, channel);

  const unfired = () => Array.from(waits.values()).some((wait) => !wait.fired);

  const fireIdle = () => {
    if (waits.size > 0) {
      return;
    }

    pending = false;
    send(IDLE_TEXT);
  };

  const fireDialog = () => {
    const open = Array.from(waits.values());
    const latest = open.at(-1);

    if (!latest) {
      return;
    }

    open.forEach((wait) => {
      wait.fired = true;
    });
    send(dialogText(latest.title));
  };

  const armIdle = () => idle.arm(fireIdle, settings().idleDelayMs);

  const armDialog = () => dialogTimer.arm(fireDialog, settings().dialogDelayMs);

  const openDialog = (owner: string, title?: string) => {
    if (!channel) {
      return;
    }

    waits.delete(owner);
    waits.set(owner, { title, fired: false });
    armDialog();
  };

  const closeDialog = (owner: string) => {
    if (!waits.delete(owner)) {
      return;
    }

    if (unfired()) {
      armDialog();
      return;
    }

    dialogTimer.clear();

    if (waits.size === 0 && pending && sources.size === 0) {
      armIdle();
    }
  };

  const key = () => {
    pending = false;
    idle.clear();

    if (unfired()) {
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
      openDialog(PI_DIALOG, event.title);
      return;
    }

    closeDialog(PI_DIALOG);
  });

  host.subscribe(AWAITING_INPUT_CHANNEL, (data) => {
    const signal = parseAwaitingInput(data);

    if (!signal) {
      return;
    }

    if (signal.waiting) {
      openDialog(signal.source, signal.title);
      return;
    }

    closeDialog(signal.source);
  });

  host.onSessionShutdown(() => {
    channel = undefined;
    pending = false;
    waits.clear();
    idle.clear();
    dialogTimer.clear();
    offKeys?.();
    offKeys = undefined;
  });
};
