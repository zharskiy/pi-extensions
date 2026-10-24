import { describe, expect, it } from "vitest";
import type { KeyPress } from "../../../pi-adapter/index.ts";
import { multiSelectForm } from "../../manager/multi-select.ts";
import { plainTheme } from "../helpers/fakes.ts";
import { char, key } from "../helpers/keys.ts";

const OPTIONS = [
  { value: "github", label: "github", description: "stdio · gh" },
  { value: "linear", label: "linear" },
  { value: "sentry", label: "sentry" },
];

const open = (spec: { checked?: boolean[]; submitHint?: string } = {}) => {
  const results: (string[] | undefined)[] = [];

  const view = multiSelectForm({ title: "Servers", options: OPTIONS, ...spec })({
    theme: plainTheme,
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

  return { view, results, press };
};

describe("multiSelectForm", () => {
  it("renders the title, checkbox rows with the given checks and the hints with the submit word", () => {
    const text = open({ checked: [true, false, true], submitHint: "add" })
      .view.render(70)
      .join("\n");

    expect(text).toContain("Servers");
    expect(text).toContain("› [x] github  stdio · gh");
    expect(text).toContain("[ ] linear");
    expect(text).toContain("[x] sentry");
    expect(text).toContain(
      " ↑↓ to select · space to toggle · a to check all · n to check none\n enter to add · esc to cancel",
    );
  });

  it("starts with nothing checked and says confirm when no checks or submit word are given", () => {
    const lines = open().view.render(80);

    expect(lines.filter((line) => line.includes("[x]"))).toEqual([]);
    expect(lines.slice(-3, -1)).toEqual([
      " ↑↓ to select · space to toggle · a to check all · n to check none",
      " enter to confirm · esc to cancel",
    ]);
  });

  it("returns every value on Enter when all start checked", () => {
    const form = open({ checked: [true, true, true] });

    form.press(key("enter"));

    expect(form.results).toEqual([["github", "linear", "sentry"]]);
  });

  it("toggles the row under the cursor with Space", () => {
    const form = open();

    form.press(key("down"), key("space"), key("down"), key("space"), key("space"), key("enter"));

    expect(form.results).toEqual([["linear"]]);
  });

  it("checks all with a and none with n", () => {
    const all = open();
    const none = open({ checked: [true, true, true] });

    all.press(char("a"), key("enter"));
    none.press(char("n"), key("down"), key("down"), key("space"), key("enter"));

    expect(all.results).toEqual([["github", "linear", "sentry"]]);
    expect(none.results).toEqual([["sentry"]]);
  });

  it("returns an empty list on Enter with nothing checked and undefined on Escape", () => {
    const empty = open();
    const cancelled = open({ checked: [true, true, true] });

    empty.press(key("enter"));
    cancelled.press(key("escape"));

    expect(empty.results).toEqual([[]]);
    expect(cancelled.results).toEqual([undefined]);
  });
});
