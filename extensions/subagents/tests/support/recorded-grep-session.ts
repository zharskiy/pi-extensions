import {
  assistantToolCallLine,
  customLine,
  toolResultLine,
  userLine,
} from "../../../../test-framework/index.ts";
import { parseSessionLines, promptRecordEntry } from "../../../../test-framework/pi/index.ts";
import { NAMESPACE } from "../../core/model/paths.ts";

const grepCall = (id: string, pattern: string) => assistantToolCallLine(id, "grep", { pattern, path: "src" });

const grepResult = (id: string, pattern: string) =>
  toolResultLine(
    id,
    "grep",
    Array.from({ length: 40 }, (_, index) => `src/${pattern}.ts:${index}: ${pattern} ${index}`).join("\n"),
  );

export const grepSession = () =>
  parseSessionLines(
    [
      userLine("Task from main (agent id explorer-1): Find"),
      customLine(promptRecordEntry(NAMESPACE), {
        providerPayload: { messages: [{ role: "user", content: "Find" }] },
      }),
      grepCall("g1", "alpha"),
      grepResult("g1", "alpha"),
      grepCall("g2", "beta"),
      grepResult("g2", "beta"),
    ],
    promptRecordEntry(NAMESPACE),
  );
