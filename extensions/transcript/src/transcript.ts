import { homedir } from "node:os";
import type { Host } from "../../../core/adapter/contract.ts";
import { EXPAND_BINDING, GLYPHS } from "../../../core/manager/row.ts";
import { transcriptRows } from "./tools.ts";

export const HIDDEN_THINKING_LABEL = `${GLYPHS.thinking} Thinking…`;

export const createTranscript = (host: Host, home = homedir()) => {
  host.registerToolRows(transcriptRows(() => host.ui.keyText(EXPAND_BINDING), home));

  host.onSessionStart((info) => {
    if (info.mode !== "tui") {
      return;
    }

    host.ui.enableMessageRows();
    host.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
  });
};
