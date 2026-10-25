import { describe, expect, it } from "vitest";
import { key, plainTheme, tokenTaggingTheme } from "../../../test/framework/index.ts";
import type { ThemeLike } from "../../pi-adapter/index.ts";
import { keyHints } from "../key-hints.ts";
import { groupedTabBar, TAB_SWITCH_HINT, tabBar, tabStep } from "../tabs.ts";

const tagged: ThemeLike = tokenTaggingTheme();

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

const GROUPS = [
  { label: "Leads", tabs: TABS },
  { label: "Chores", tabs: [{ label: "Three", done: false }] },
];

describe("groupedTabBar", () => {
  it("renders one labelled row per group with submit closing the last row", () => {
    expect(groupedTabBar(plainTheme, GROUPS, 0, false, 80)).toEqual([
      "Leads   ■ One  □ Two",
      "Chores  □ Three  ✓ Submit",
    ]);
  });

  it("highlights the current tab by its global index across groups", () => {
    const [leads, chores] = groupedTabBar(tagged, GROUPS, 2, false, 80);

    expect(leads).not.toContain("<accent>");
    expect(chores).toContain("<accent>□ Three</>");
    expect(chores).toContain("<dim>✓ Submit</>");
  });

  it("highlights submit when the current index is past the last tab", () => {
    const [leads, chores] = groupedTabBar(tagged, GROUPS, 3, true, 80);

    expect(leads).not.toContain("<accent>");
    expect(chores).toContain("<accent>✓ Submit</>");
  });

  it("skips a group without tabs", () => {
    const groups = [{ label: "Leads", tabs: [] }, ...GROUPS.slice(1)];

    expect(groupedTabBar(plainTheme, groups, 1, true, 80)).toEqual(["Chores  □ Three  ✓ Submit"]);
  });

  it("wraps a long row under its own label", () => {
    const tabs = ["Alpha", "Bravo", "Charlie", "Delta"].map((label) => ({ label, done: false }));
    const lines = groupedTabBar(plainTheme, [{ label: "Leads", tabs }], 0, false, 30);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^Leads {3}□ Alpha/);
    expect(lines.slice(1).every((line) => line.startsWith(" ".repeat(8)) && line.trim() !== "")).toBe(true);
    expect(lines.every((line) => line.length <= 30)).toBe(true);
  });
});

describe("tab hint", () => {
  it("names the switch keys in lower case", () => {
    expect(keyHints([TAB_SWITCH_HINT], plainTheme)).toBe("tab/←→ to switch");
  });
});
