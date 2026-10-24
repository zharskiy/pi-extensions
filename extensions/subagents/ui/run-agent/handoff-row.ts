import { homedir } from "node:os";
import { homeRelative } from "../../../../platform/shared/index.ts";
import { markOf, row, rowChildren, rowText } from "../../../../platform/ui-kit/index.ts";
import type { HandoffRows } from "../../core/run-agent/handoff-tool.ts";

export const handoffRows = (savedPath: () => string | undefined): HandoffRows => ({
  renderCall: (_params, theme, state) =>
    rowText(row({ mark: markOf(state), title: { verb: (paint) => paint.bold("handoff") } }), theme),
  renderResult: (result, _state, theme) => {
    if (result.isError) {
      const lines = result.text.split("\n");

      return rowText(rowChildren({ children: lines.map((line) => theme.fg("error", line)) }), theme);
    }

    const path = savedPath();
    const saved = path ? `Saved ${homeRelative(path, homedir())}` : result.text;

    return rowText(rowChildren({ children: [theme.fg("muted", saved)] }), theme);
  },
});
