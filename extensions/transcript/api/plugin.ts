import { homedir } from "node:os";
import type { Host } from "../../../platform/pi-adapter/index.ts";
import { BACKGROUND_WORK_CHANNEL, type Plugin, parseBackgroundWork } from "../../../platform/shared/index.ts";
import { EXPAND_BINDING, MARKS } from "../../../platform/ui-kit/index.ts";
import { countTools, openTurn, settledAnswer, type TurnWork } from "../core/turn-summary.ts";
import { answerRule } from "../ui/answer-rule.ts";
import { transcriptRows } from "../ui/tools.ts";

const THINKING_BINDING = "app.thinking.toggle";

const THINKING_LABEL = `${MARKS.thinking} Thinking`;

const ANSWER_ENTRY = "pi-transcript:answer";

export const createTranscript = (host: Host, home = homedir()) => {
  const pending = new Map<string, number>();
  let turn: TurnWork | undefined;
  let running = false;
  let tui = false;

  const waiting = () => Array.from(pending.values()).some((count) => count > 0);

  const settle = () => {
    const answer = turn && settledAnswer(turn, Date.now());

    turn = undefined;

    if (tui && answer) {
      host.appendEntry(ANSWER_ENTRY, answer);
    }
  };

  host.registerToolRows(transcriptRows(() => host.ui.keyText(EXPAND_BINDING), home));
  host.registerEntryRenderer(ANSWER_ENTRY, answerRule);

  host.onSessionStart((info) => {
    tui = info.mode === "tui";
    turn = undefined;
    running = false;

    if (!tui) {
      return;
    }

    const key = host.ui.keyText(THINKING_BINDING);

    host.ui.setHiddenThinkingLabel(THINKING_LABEL, key ? `(${key} to expand)` : undefined);
  });

  host.onAgentStart(() => {
    running = true;
    turn ??= openTurn(Date.now());
  });

  host.onAssistantEnd((info) => {
    if (turn) {
      turn = countTools(turn, info);
    }
  });

  host.onIdle(({ aborted }) => {
    running = false;

    if (aborted) {
      turn = undefined;
      return;
    }

    if (!waiting()) {
      settle();
    }
  });

  host.subscribe(BACKGROUND_WORK_CHANNEL, (data) => {
    const report = parseBackgroundWork(data);

    if (!report) {
      return;
    }

    pending.set(report.source, report.count);

    if (!running && !waiting()) {
      settle();
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
