import type { Host } from "../../../core/adapter/contract.ts";
import { createFrame } from "./frame.ts";

const CHEVRON = "❯";

export const createComposer = (host: Host, chevron = CHEVRON) => {
  const frame = createFrame(chevron);

  host.onSessionStart(() => {
    host.ui.setEditorFrame(frame);
  });
};
