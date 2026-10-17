import type { KeyPress, ThemeLike } from "../adapter/contract.ts";

export type Tab = { label: string; done: boolean };

export const TAB_SWITCH_HINT = "Tab/←→ switch";

const SUBMIT_LABEL = "✓ Submit";

const STEPS: Partial<Record<KeyPress["name"], number>> = { tab: 1, right: 1, backTab: -1, left: -1 };

export const tabStep = (key: KeyPress, current: number, count: number) => {
  const step = STEPS[key.name];

  return step === undefined || count < 1 ? undefined : (current + step + count) % count;
};

export const tabBar = (theme: ThemeLike, tabs: readonly Tab[], current: number, ready: boolean) => {
  const active = (text: string) => theme.fg("accent", theme.bold(text));

  const labels = tabs.map((tab, index) => {
    const box = tab.done ? "■" : "□";

    if (index === current) {
      return active(`${box} ${tab.label}`);
    }

    const label = theme.fg(tab.done ? "text" : "muted", tab.label);

    return `${theme.fg(tab.done ? "success" : "muted", box)} ${label}`;
  });

  const submit =
    current === tabs.length ? active(SUBMIT_LABEL) : theme.fg(ready ? "success" : "dim", SUBMIT_LABEL);

  return `${theme.fg("dim", "←")} ${[...labels, submit].join("  ")} ${theme.fg("dim", "→")}`;
};
