import { homedir } from "node:os";
import type { Host } from "../../../core/adapter/contract.ts";
import { EXPAND_BINDING, GLYPHS } from "../../../core/manager/row.ts";
import { transcriptRows } from "./tools.ts";

const THINKING_BINDING = "app.thinking.toggle";

export const hiddenThinkingLabel = (key: string) =>
  key ? `${GLYPHS.thinking} Thinking (${key} expand)` : `${GLYPHS.thinking} Thinking`;

export const createTranscript = (host: Host, home = homedir()) => {
  host.registerToolRows(transcriptRows(() => host.ui.keyText(EXPAND_BINDING), home));

  host.onSessionStart((info) => {
    if (info.mode !== "tui") {
      return;
    }

    host.ui.enableMessageRows();
    host.ui.setHiddenThinkingLabel(hiddenThinkingLabel(host.ui.keyText(THINKING_BINDING)));
  });
};
