import { homedir } from "node:os";
import type { Host } from "../../../platform/pi-adapter/index.ts";
import type { Plugin } from "../../../platform/shared/index.ts";
import { EXPAND_BINDING } from "../../../platform/ui-kit/index.ts";
import { transcriptRows } from "../ui/tools.ts";

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

export const transcriptPlugin: Plugin<never, never, undefined> = {
  id: "transcript",
  enable({ host }) {
    createTranscript(host);
    return undefined;
  },
};
