import type { KeyPress, ThemeLike } from "../pi-adapter/index.ts";
import { prefixed } from "../shared/index.ts";
import type { KeyHint } from "./key-hints.ts";

export type Tab = { label: string; done: boolean };

type TabGroup = { label: string; tabs: readonly Tab[] };

export const TAB_SWITCH_HINT: KeyHint = ["tab/←→", "to switch"];

const SUBMIT_LABEL = "✓ Submit";

const GROUP_LABEL_WIDTH = 8;

const STEPS: Partial<Record<KeyPress["name"], number>> = { tab: 1, right: 1, backTab: -1, left: -1 };

export const tabStep = (key: KeyPress, current: number, count: number) => {
  const step = STEPS[key.name];

  return step === undefined || count < 1 ? undefined : (current + step + count) % count;
};

const active = (theme: ThemeLike, text: string) => theme.fg("accent", theme.bold(text));

const tabLabel = (theme: ThemeLike, tab: Tab, isCurrent: boolean) => {
  const box = tab.done ? "■" : "□";

  if (isCurrent) {
    return active(theme, `${box} ${tab.label}`);
  }

  const label = theme.fg(tab.done ? "text" : "muted", tab.label);

  return `${theme.fg(tab.done ? "success" : "muted", box)} ${label}`;
};

const submitLabel = (theme: ThemeLike, isCurrent: boolean, ready: boolean) =>
  isCurrent ? active(theme, SUBMIT_LABEL) : theme.fg(ready ? "success" : "dim", SUBMIT_LABEL);

export const tabBar = (theme: ThemeLike, tabs: readonly Tab[], current: number, ready: boolean) => {
  const labels = tabs.map((tab, index) => tabLabel(theme, tab, index === current));
  const submit = submitLabel(theme, current === tabs.length, ready);

  return `${theme.fg("dim", "←")} ${[...labels, submit].join("  ")} ${theme.fg("dim", "→")}`;
};

export const groupedTabBar = (
  theme: ThemeLike,
  groups: readonly TabGroup[],
  current: number,
  ready: boolean,
  width: number,
) => {
  const total = groups.reduce((sum, group) => sum + group.tabs.length, 0);
  const shown = groups.filter((group) => group.tabs.length > 0);
  const offsets = shown.map((_, index) =>
    shown.slice(0, index).reduce((sum, group) => sum + group.tabs.length, 0),
  );
  const submit = submitLabel(theme, current === total, ready);

  return shown.flatMap((group, index) => {
    const labels = group.tabs.map((tab, position) =>
      tabLabel(theme, tab, offsets[index] + position === current),
    );
    const row = index === shown.length - 1 ? [...labels, submit] : labels;
    const title = theme.fg("muted", group.label.padEnd(GROUP_LABEL_WIDTH));

    return prefixed(theme, title, row.join("  "), width);
  });
};
