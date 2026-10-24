import type { Host, NotifyChannel } from "../../../pi-adapter/index.ts";
import {
  AWAITING_INPUT_CHANNEL,
  BUSY_CHANNEL,
  parseAwaitingInput,
  parseBusySignal,
} from "../../../shared/index.ts";
import type { NotificationSettings } from "./settings.ts";

const IDLE_TEXT = "pi is waiting for your input";

const DIALOG = "dialog";

const sourceKey = (source: string) => `source:${source}`;

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
  const waitTimer = slot();
  const waits = new Map<string, { title?: string; fired: boolean }>();
  let channel: NotifyChannel | undefined;
  let pending = false;
  let offKeys: (() => void) | undefined;

  const send = (text: string) => channel && host.ui.terminalNotify(text, channel);

  const hasUnnotified = () => Array.from(waits.values()).some((wait) => !wait.fired);

  const fireIdle = () => {
    if (waits.size > 0) {
      return;
    }

    pending = false;
    send(IDLE_TEXT);
  };

  const fireWait = () => {
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

  const armWait = () => waitTimer.arm(fireWait, settings().dialogDelayMs);

  const openWait = (owner: string, title?: string) => {
    if (!channel) {
      return;
    }

    waits.delete(owner);
    waits.set(owner, { title, fired: false });
    armWait();
  };

  const closeWait = (owner: string) => {
    if (!waits.delete(owner)) {
      return;
    }

    if (hasUnnotified()) {
      armWait();
      return;
    }

    waitTimer.clear();

    if (waits.size === 0 && pending && sources.size === 0) {
      armIdle();
    }
  };

  const key = () => {
    pending = false;
    idle.clear();

    if (hasUnnotified()) {
      armWait();
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
      openWait(DIALOG, event.title);
      return;
    }

    closeWait(DIALOG);
  });

  host.subscribe(AWAITING_INPUT_CHANNEL, (data) => {
    const signal = parseAwaitingInput(data);

    if (!signal) {
      return;
    }

    if (signal.waiting) {
      openWait(sourceKey(signal.source), signal.title);
      return;
    }

    closeWait(sourceKey(signal.source));
  });

  host.onSessionShutdown(() => {
    channel = undefined;
    pending = false;
    waits.clear();
    idle.clear();
    waitTimer.clear();
    offKeys?.();
    offKeys = undefined;
  });
};
