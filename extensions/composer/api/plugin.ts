import type { Host } from "../../../pi-adapter/index.ts";
import type { Plugin } from "../../../shared/index.ts";
import { createFrame } from "../ui/frame.ts";

export const createComposer = (host: Host) => {
  const frame = createFrame();

  host.onSessionStart(() => {
    host.ui.setEditorFrame(frame);
  });
};

export const composerPlugin: Plugin<never, never, undefined> = {
  id: "composer",
  enable({ host }) {
    createComposer(host);

    return undefined;
  },
};
