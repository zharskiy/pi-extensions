import type { DialogEvent, NotifyChannel, RunMode } from "../../../platform/pi-adapter/index.ts";
import { parseAwaitingInput, trackBusy } from "../../../platform/shared/index.ts";
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

export const createNotifier = (
  settings: NotificationSettings,
  notify: (text: string, channel: NotifyChannel) => void,
) => {
  const idle = slot();
  const waitTimer = slot();
  const waits = new Map<string, { title?: string; fired: boolean }>();
  let channel: NotifyChannel | undefined;
  let pending = false;

  const send = (text: string) => channel && notify(text, channel);

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

    open.forEach((wait) => {
      wait.fired = true;
    });
    send(dialogText(open.at(-1)?.title));
  };

  const armIdle = () => idle.arm(fireIdle, settings.idleDelayMs);

  const tracker = trackBusy({ onBusy: idle.clear, onQuiet: () => pending && armIdle() });

  const quiet = () => tracker.sources().length === 0;

  const armWait = () => waitTimer.arm(fireWait, settings.dialogDelayMs);

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

    if (waits.size === 0 && pending && quiet()) {
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

  const start = (mode: RunMode) => {
    const configured = settings.channel;

    channel = mode === "tui" && configured !== "off" ? configured : undefined;

    return channel !== undefined;
  };

  const settled = () => {
    if (!channel) {
      return;
    }

    pending = true;

    if (quiet()) {
      armIdle();
    }
  };

  const agentStart = () => {
    pending = false;
    idle.clear();
  };

  const dialog = (event: DialogEvent) => {
    if (event.kind === "custom") {
      return;
    }

    if (event.phase === "start") {
      openWait(DIALOG, event.title);
      return;
    }

    closeWait(DIALOG);
  };

  const awaiting = (data: unknown) => {
    const signal = parseAwaitingInput(data);

    if (!signal) {
      return;
    }

    if (signal.waiting) {
      openWait(sourceKey(signal.source), signal.title);
      return;
    }

    closeWait(sourceKey(signal.source));
  };

  const shutdown = () => {
    channel = undefined;
    pending = false;
    waits.clear();
    idle.clear();
    waitTimer.clear();
  };

  return { start, key, busy: tracker.receive, settled, agentStart, dialog, awaiting, shutdown };
};
