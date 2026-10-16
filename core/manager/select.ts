import type { FormFactory, ThemeLike } from "../adapter/contract.ts";
import { hintLines, padded, rule } from "./layout.ts";
import { CANCEL_HINT, clampIndex, type ListOption, listKey, listLines, SELECT_HINTS } from "./list.ts";

export type SelectOption<T> = ListOption & { value: T };

export type SelectSpec<T> = {
  title: string;
  options: readonly SelectOption<T>[];
  selected?: number;
};

const HINTS = [...SELECT_HINTS, "Enter choose", CANCEL_HINT];

const renderSelect = <T>(spec: SelectSpec<T>, selected: number, theme: ThemeLike, width: number) => [
  rule(theme, width),
  ...padded(theme, theme.fg("text", spec.title), width),
  "",
  ...listLines(theme, spec.options, selected, width, { layout: "beside" }),
  "",
  ...hintLines(theme, HINTS, width),
  rule(theme, width),
];

export const selectForm =
  <T>(spec: SelectSpec<T>): FormFactory<T | undefined> =>
  (api) => {
    let selected = clampIndex(spec.selected ?? 0, spec.options.length);

    return {
      render: (width) => renderSelect(spec, selected, api.theme, width),
      handleKey: (key) => {
        if (key.name === "escape") {
          api.done(undefined);
          return;
        }

        const step = listKey(key, selected, spec.options.length);

        if (!step) {
          return;
        }

        selected = step.index;

        if (step.pick) {
          api.done(spec.options[selected]?.value);
          return;
        }

        api.requestRender();
      },
    };
  };
