import type { ThemeLike } from "../../../core/adapter/contract.ts";
import { bold, type Context, firstLineFailure, type Look, orError, resultText } from "./look.ts";
import { outputLines, previewRows, wrappedRows } from "./output.ts";

const MAX_PAIRS = 3;

const MAX_VALUE = 40;

const valueText = (value: unknown, theme: ThemeLike) => {
  const text = JSON.stringify(value) ?? String(value);

  return theme.truncate(text.replace(/\s*\n\s*/g, " "), MAX_VALUE);
};

const pairs = (context: Context, theme: ThemeLike) =>
  Object.entries(context.args)
    .slice(0, MAX_PAIRS)
    .map(([name, value]) => `${name}=${valueText(value, theme)}`)
    .join(" ");

const outcome = orError((context: Context, room: number, theme: ThemeLike) => {
  const lines = outputLines(resultText(context));

  if (lines.length === 0) {
    return { lines: context.view.isPartial ? [] : [theme.fg("muted", "No output")] };
  }

  if (context.view.expanded) {
    return { lines: wrappedRows(lines, "muted", room, theme) };
  }

  const cut = lines.length <= 3 && lines.some((line) => theme.width(line) > room);

  return {
    lines: previewRows(lines, { keep: "head", token: "muted", room, key: context.key }, theme),
    hint: cut,
  };
});

export const genericLook = (name: string, label: string | undefined): Look => ({
  verb: label === undefined ? bold(name) : undefined,
  title: (context, theme) => {
    const args = pairs(context, theme);
    const shown = args === "" ? {} : { args };

    return label === undefined
      ? shown
      : { target: { text: label, token: "accent" as const, bold: true, cut: "end" as const }, ...shown };
  },
  outcome,
  failure: firstLineFailure,
});
