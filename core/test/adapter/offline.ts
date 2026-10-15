import type { TranscriptPane } from "../../adapter/contract.ts";
import { createTranscriptPane, type TranscriptPaneOptions } from "../../adapter/pi-transcript.ts";
import { createScrollPane } from "../../adapter/pi-ui.ts";

export { formatRoutedMessage } from "../../adapter/route.ts";
export { parseSessionLines, promptRecordEntry, readSessionFile } from "../../adapter/session-file.ts";

export const realOverlayParts = (requestRender: () => void) => ({
  createTranscript: (options?: TranscriptPaneOptions): TranscriptPane =>
    createTranscriptPane({ requestRender } as never, "/repo", options),
  createScroll: () => createScrollPane(requestRender),
});
