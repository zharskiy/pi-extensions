import type { ThemeLike } from "../../../pi-adapter/index.ts";
import { outputLines, previewRows, shellResult } from "./output.ts";
import {
  bold,
  type Context,
  errorOutcome,
  failed,
  firstLineFailure,
  type Look,
  MORE,
  resultText,
  textArg,
} from "./tool-look.ts";

const title = (context: Context) => {
  const command = textArg(context.args, "command");

  if (command === undefined) {
    return undefined;
  }

  const [first = "", ...rest] = command.split("\n");
  const more = rest.some((line) => line.trim() !== "");

  return {
    target: { text: first, cut: "end" as const, ...(more ? { tail: MORE } : {}) },
  };
};

const outcome = (context: Context, room: number, theme: ThemeLike, reasonShown: boolean) => {
  const view = context.view;
  const status = shellResult(resultText(context));

  if (failed(context) && status.reason === undefined) {
    return errorOutcome(context, room, theme, reasonShown);
  }

  const reason = failed(context) && !reasonShown && status.reason ? [theme.fg("error", status.reason)] : [];
  const lines = outputLines(status.output);

  if (lines.length === 0) {
    return { lines: view.isPartial || view.isError ? reason : [theme.fg("muted", "No output")] };
  }

  if (view.expanded) {
    return { lines: reason };
  }

  return {
    lines: [
      ...reason,
      ...previewRows(lines, { keep: "tail", token: "muted", room, key: context.key }, theme),
    ],
  };
};

export const shellLook = (id: string): Look => ({
  verb: bold(id),
  title,
  failure: (context) => {
    const status = shellResult(resultText(context));

    return status.reason === undefined
      ? firstLineFailure(context)
      : { text: status.reason, timedOut: status.timedOut };
  },
  outcome,
  piBody: (context) => {
    const status = shellResult(resultText(context));

    if (failed(context) && status.reason === undefined) {
      return false;
    }

    return outputLines(status.output).length > 0;
  },
  dropTiming: true,
  streams: true,
});
