import type { ThemeLike, ToolRow } from "../../../platform/pi-adapter/index.ts";
import { DOT } from "../../../platform/shared/index.ts";
import { appendHint, expandHint } from "../../../platform/ui-kit/index.ts";
import { readRange } from "../core/tool-kinds.ts";
import { type Context, failed, fileFailure, stopped } from "./tool-look.ts";

const failureReason = (context: Context) => (fileFailure(context)?.text ?? "Error").split("\n")[0] ?? "Error";

const baseLine = (context: Context, name: string, theme: ThemeLike) => {
  const range = readRange(context.args);

  return [
    theme.fg("customMessageLabel", theme.bold("[skill]")),
    " ",
    theme.fg("customMessageText", name),
    range === "" ? "" : theme.fg("warning", range),
  ].join("");
};

const skillLine = (context: Context, name: string, width: number, theme: ThemeLike) => {
  const base = baseLine(context, name, theme);

  if (stopped(context.view)) {
    return theme.truncate(`${base}${theme.fg("muted", DOT)}${theme.fg("muted", "stopped")}`, width);
  }

  if (failed(context)) {
    return theme.truncate(
      `${base}${theme.fg("muted", DOT)}${theme.fg("error", failureReason(context))}`,
      width,
    );
  }

  if (context.view.result === undefined) {
    return theme.truncate(base, width);
  }

  return appendHint(base, expandHint(context.key), width, theme);
};

export const skillRow = (context: Context, name: string): ToolRow => ({
  call: (width, theme) => [skillLine(context, name, width, theme)],
});
