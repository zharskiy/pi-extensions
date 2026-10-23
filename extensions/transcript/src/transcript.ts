import { homedir } from "node:os";
import type { Host } from "../../../core/adapter/contract.ts";
import { EXPAND_BINDING } from "../../../core/manager/row.ts";
import { transcriptRows } from "./tools.ts";

const THINKING_BINDING = "app.thinking.toggle";

const THINKING_LABEL = "Thinking";

export const createTranscript = (host: Host, home = homedir()) => {
  host.registerToolRows(transcriptRows(() => host.ui.keyText(EXPAND_BINDING), home));

  host.onSessionStart((info) => {
    if (info.mode !== "tui") {
      return;
    }

    const key = host.ui.keyText(THINKING_BINDING);

    host.ui.setHiddenThinkingLabel(THINKING_LABEL, key ? `(${key} to expand)` : undefined);
  });
};
