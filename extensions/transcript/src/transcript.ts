import { homedir } from "node:os";
import type { Host } from "../../../core/adapter/contract.ts";
import { transcriptRows } from "./tools.ts";

export const HIDDEN_THINKING_LABEL = "∴ Thinking…";

const EXPAND_KEY = "app.tools.expand";

export const createTranscript = (host: Host, home = homedir()) => {
  host.registerToolRows(transcriptRows(() => host.ui.keyText(EXPAND_KEY), home));

  host.onSessionStart((info) => {
    if (info.mode !== "tui") {
      return;
    }

    host.ui.enableMessageRows();
    host.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
  });
};
