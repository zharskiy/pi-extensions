import { homedir } from "node:os";
import type { Host } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";
import { EXPAND_BINDING, MARKS } from "../../../platform/ui-kit/index.ts";
import { afterMessage, type RunWork, startRun } from "../core/turn-summary.ts";
import { answerRule } from "../ui/answer-rule.ts";
import { transcriptRows } from "../ui/tools.ts";

const THINKING_BINDING = "app.thinking.toggle";

const THINKING_LABEL = `${MARKS.thinking} Thinking`;

const ANSWER_ENTRY = "pi-transcript:answer";

export const createTranscript = (host: Host, home = homedir()) => {
  let work: RunWork | undefined;
  let tui = false;

  host.registerToolRows(transcriptRows(() => host.ui.keyText(EXPAND_BINDING), home));
  host.registerEntryRenderer(ANSWER_ENTRY, answerRule);

  host.onSessionStart((info) => {
    tui = info.mode === "tui";

    if (!tui) {
      return;
    }

    const key = host.ui.keyText(THINKING_BINDING);

    host.ui.setHiddenThinkingLabel(THINKING_LABEL, key ? `(${key} to expand)` : undefined);
  });

  host.onAgentStart(() => {
    work ??= startRun(Date.now());
  });

  host.onIdle(() => {
    work = undefined;
  });

  host.onAssistantEnd((info) => {
    if (!work) {
      return;
    }

    const next = afterMessage(work, info, Date.now());

    work = next.work;

    if (tui && next.entry) {
      host.appendEntry(ANSWER_ENTRY, next.entry);
    }
  });
};

export const transcriptPlugin: Plugin<never, never, undefined> = {
  id: "transcript",
  enable({ host }) {
    createTranscript(host);
    return undefined;
  },
};
