import { describe, expect, it } from "vitest";
import { char, key, plainTheme, tokenTaggingTheme } from "../../../test/framework/index.ts";
import type { KeyPress, ThemeLike } from "../../pi-adapter/index.ts";
import { type SelectOption, selectForm } from "../select.ts";

const tagged: ThemeLike = tokenTaggingTheme();

const OPTIONS = [
  { value: "a", label: "Alpha", description: "first one" },
  { value: "b", label: "Beta", mark: "✓" },
  { value: "c", label: "Gamma", description: "third one" },
];

const open = ({
  selected,
  options = OPTIONS,
  theme = plainTheme,
}: {
  selected?: number;
  options?: SelectOption<string>[];
  theme?: ThemeLike;
} = {}) => {
  const results: (string | undefined)[] = [];

  const view = selectForm({ title: "Pick", options, selected })({
    theme,
    requestRender: () => {},
    done: (result) => {
      results.push(result);
    },
    createTextInput: () => {
      throw new Error("no text input");
    },
  });

  const press = (...keys: KeyPress[]) => {
    keys.forEach((pressed) => {
      view.handleKey(pressed);
    });
  };

  const pointer = () => view.render(60).find((line) => line.startsWith(" ›"));

  return { view, results, press, pointer };
};

describe("selectForm", () => {
  it("renders the title, the list with descriptions beside the labels from the preselected row and the hints", () => {
    expect(open({ selected: 1 }).view.render(60)).toEqual([
      "─".repeat(60),
      " Pick",
      "",
      "   1. Alpha  first one",
      " › 2. Beta ✓",
      "   3. Gamma  third one",
      "",
      " ↑↓ to select · 1-9 to pick · enter to choose",
      " esc to cancel",
      "─".repeat(60),
    ]);
  });

  it("colours the rules and the pointer row in accent and the hints dim", () => {
    const lines = open({ theme: tagged }).view.render(60);

    expect(lines[0]).toContain("<accent>");
    expect(lines.at(-1)).toContain("<accent>");
    expect(lines[3]).toContain("<accent>1. Alpha");
    expect(lines[4]).toContain("<text>2. Beta");
    expect(lines.at(-2)).toContain("<dim>");
  });

  it("moves the pointer with the arrow keys and stays put at the first and last row", () => {
    const form = open();

    form.press(key("up"));

    expect(form.pointer()).toBe(" › 1. Alpha  first one");

    form.press(key("down"), key("down"), key("down"));

    expect(form.pointer()).toBe(" › 3. Gamma  third one");

    form.press(key("home"));

    expect(form.pointer()).toBe(" › 1. Alpha  first one");
    expect(form.results).toEqual([]);
  });

  it("returns the value picked with Enter after moving", () => {
    const form = open();

    form.press(key("down"), key("down"), key("enter"));

    expect(form.results).toEqual(["c"]);
  });

  it("returns the value of a digit, ignores a digit past the list and returns nothing on Escape", () => {
    const picked = open();
    const cancelled = open({ selected: 2 });

    picked.press(char("7"), char("2"));
    cancelled.press(key("escape"));

    expect(picked.results).toEqual(["b"]);
    expect(cancelled.results).toEqual([undefined]);
  });

  it("puts the pointer on the nearest row when the preselected index is out of range", () => {
    expect(open({ selected: 9 }).pointer()).toBe(" › 3. Gamma  third one");
    expect(open({ selected: -2 }).pointer()).toBe(" › 1. Alpha  first one");
  });

  it("renders an empty list and returns nothing when Enter is pressed on it", () => {
    const form = open({ options: [] });

    expect(form.view.render(40).slice(1, 4)).toEqual([" Pick", "", ""]);

    form.press(key("down"), key("enter"));

    expect(form.results).toEqual([undefined]);
  });

  it("wraps a long label at a narrow width", () => {
    const form = open({ options: [{ value: "x", label: "A rather long option label" }] });

    expect(form.view.render(14).slice(3, 6)).toEqual([" › 1. A rather", "   long option", "   label"]);
  });
});
