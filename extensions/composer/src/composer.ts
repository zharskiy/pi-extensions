import type { Host } from "../../../core/adapter/contract.ts";
import { createFrame } from "./frame.ts";

export const createComposer = (host: Host) => {
  const frame = createFrame();

  host.onSessionStart(() => {
    host.ui.setEditorFrame(frame);
  });
};
