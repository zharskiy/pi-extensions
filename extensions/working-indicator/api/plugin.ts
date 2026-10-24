import type { Host, Phase } from "../../../pi-adapter/index.ts";
import type { Plugin } from "../../../shared/index.ts";
import { elapsedOf, isVisibleIn, type Run, rotateVerb, startRun, TICK_MS } from "../core/indicator-state.ts";
import { interruptHint, pickVerb, workingText } from "../ui/indicator-text.ts";

const INTERRUPT_BINDING = "app.interrupt";

export const createWorkingIndicator = (host: Host) => {
  let run: Run | undefined;
  let hidden = false;
  let written: string | undefined;

  const write = (active: Run) => {
    const text = workingText(active.verb, elapsedOf(active), active.hint);

    if (text === written) {
      return;
    }

    written = text;
    host.ui.setWorkingMessage(text);
  };

  const tick = () => {
    if (!run) {
      return;
    }

    rotateVerb(run, pickVerb);
    write(run);
  };

  const applyVisibility = (next: Phase) => {
    const visible = isVisibleIn(next);

    if (visible === !hidden) {
      return;
    }

    host.ui.setWorkingVisible(visible);
    hidden = !visible;
  };

  const begin = () => {
    const timer = setInterval(tick, TICK_MS);
    const key = host.ui.keyText(INTERRUPT_BINDING);

    timer.unref?.();
    run = startRun(
      timer,
      interruptHint(key, (text) => host.ui.style("dim", text)),
      pickVerb(),
    );

    write(run);
  };

  const stop = () => {
    if (!run) {
      return;
    }

    clearInterval(run.timer);
    run = undefined;
    written = undefined;
    host.ui.setWorkingMessage(undefined);
  };

  const end = () => {
    applyVisibility("idle");
    stop();
  };

  host.onAgentStart(() => {
    if (host.session().mode !== "tui" || run) {
      return;
    }

    begin();
  });

  host.onPhase((next) => {
    if (next === "idle") {
      end();
      return;
    }

    if (!run) {
      return;
    }

    applyVisibility(next);
  });

  host.onSessionShutdown(() => {
    stop();
  });
};

export const workingIndicatorPlugin: Plugin<never, never, undefined> = {
  id: "working-indicator",
  enable({ host }) {
    createWorkingIndicator(host);

    return undefined;
  },
};
