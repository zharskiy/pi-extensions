import { describe, expect, it } from "vitest";
import type { KeyPress, ThemeLike } from "../../adapter/contract.ts";
import { keyHints } from "../../manager/layout.ts";
import { TAB_SWITCH_HINT, tabBar, tabStep } from "../../manager/tabs.ts";
import { plainTheme } from "../helpers/fakes.ts";

const tagged: ThemeLike = { ...plainTheme, fg: (token, text) => `<${token}>${text}</>` };

const key = (name: KeyPress["name"]): KeyPress => ({ name });

const TABS = [
  { label: "One", done: true },
  { label: "Two", done: false },
];

describe("tabStep", () => {
  it("moves forward with Tab and →, back with Shift+Tab and ←, and wraps at both ends", () => {
    expect(tabStep(key("tab"), 0, 3)).toBe(1);
    expect(tabStep(key("right"), 2, 3)).toBe(0);
    expect(tabStep(key("backTab"), 0, 3)).toBe(2);
    expect(tabStep(key("left"), 1, 3)).toBe(0);
  });

  it("ignores other keys and an empty tab set", () => {
    expect(tabStep(key("up"), 0, 3)).toBeUndefined();
    expect(tabStep(key("enter"), 0, 3)).toBeUndefined();
    expect(tabStep(key("tab"), 0, 0)).toBeUndefined();
  });
});

describe("tabBar", () => {
  it("shows a filled box for done tabs, an empty one otherwise, and the submit tab last", () => {
    expect(tabBar(plainTheme, TABS, 1, false)).toBe("← ■ One  □ Two  ✓ Submit →");
  });

  it("colours the current tab accent, done tabs success, open tabs muted and a ready submit success", () => {
    const bar = tabBar(tagged, TABS, 1, true);

    expect(bar).toContain("<success>■</> <text>One</>");
    expect(bar).toContain("<accent>□ Two</>");
    expect(bar).toContain("<success>✓ Submit</>");
    expect(tabBar(tagged, TABS, 0, false)).toContain("<dim>✓ Submit</>");
    expect(tabBar(tagged, TABS, 2, false)).toContain("<accent>✓ Submit</>");
  });
});

describe("tab hint", () => {
  it("names the switch keys in lower case", () => {
    expect(keyHints([TAB_SWITCH_HINT], plainTheme)).toBe("tab/←→ to switch");
  });
});
