import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ChildPrompts } from "../../src/adapter/contract.ts";
import { childUiContext } from "../../src/adapter/pi-child.ts";
import { createInputPane } from "../../src/adapter/pi-ui.ts";

const APC = new RegExp(
  `${String.fromCharCode(27)}_[^${String.fromCharCode(7)}]*${String.fromCharCode(7)}`,
  "g",
);
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const visibleText = (lines: string[]) => lines.join("\n").replace(APC, "").replace(SGR, "");

const typeText = (pane: ReturnType<typeof createInputPane>, text: string) =>
  text.split("").map((char) => pane.feed({ name: "other", char, raw: char }));

describe("createInputPane", () => {
  it("collects typed characters as changes", () => {
    const pane = createInputPane("type");
    const outcomes = typeText(pane, "hi");

    expect(outcomes).toEqual(["changed", "changed"]);
    expect(pane.value()).toBe("hi");
    expect(visibleText(pane.render(30))).toContain("hi");
  });

  it("reports submitted on enter and cancelled on escape", () => {
    const pane = createInputPane("type");

    expect(pane.feed({ name: "enter", raw: "\r" })).toBe("submitted");
    expect(pane.feed({ name: "escape", raw: "\x1b" })).toBe("cancelled");
    expect(pane.feed({ name: "other", char: "a", raw: "a" })).toBe("changed");
  });

  it("deletes the last character on backspace", () => {
    const pane = createInputPane("type");

    typeText(pane, "abc");

    expect(pane.feed({ name: "other", raw: "\x7f" })).toBe("changed");
    expect(pane.value()).toBe("ab");
  });

  it("sets the value and renders it", () => {
    const pane = createInputPane("type");

    pane.setValue("preset");

    expect(pane.value()).toBe("preset");
    expect(visibleText(pane.render(30))).toContain("preset");
  });
});

describe("createInputPane focus", () => {
  it("draws the cursor marker only while focused", () => {
    const pane = createInputPane("type");

    pane.setValue("hi");
    pane.setFocused(false);

    expect(pane.render(30).join("")).not.toContain(CURSOR_MARKER);

    pane.setFocused(true);

    expect(pane.render(30).join("")).toContain(CURSOR_MARKER);
  });
});

describe("childUiContext", () => {
  const theme = { name: "fake" } as unknown as Theme;

  it("forwards the four dialogs to the prompts and returns their results", async () => {
    const prompts: ChildPrompts = {
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "b"),
      input: vi.fn(async () => "typed"),
      notify: vi.fn(),
    };

    const ui = childUiContext(theme, prompts);

    expect(await ui.confirm("t", "m")).toBe(true);
    expect(await ui.select("t", ["a", "b"])).toBe("b");
    expect(await ui.input("t", "ph")).toBe("typed");

    ui.notify("hello", "warning");

    expect(prompts.confirm).toHaveBeenCalledWith("t", "m");
    expect(prompts.select).toHaveBeenCalledWith("t", ["a", "b"]);
    expect(prompts.input).toHaveBeenCalledWith("t", "ph");
    expect(prompts.notify).toHaveBeenCalledWith("hello", "warning");
  });

  it("denies everything without prompts", async () => {
    const ui = childUiContext(theme, undefined);

    expect(await ui.confirm("t", "m")).toBe(false);
    expect(await ui.select("t", ["a"])).toBeUndefined();
    expect(await ui.input("t")).toBeUndefined();
    expect(() => ui.notify("x")).not.toThrow();
  });

  it("uses the given theme and keeps the rest harmless", () => {
    const ui = childUiContext(theme, undefined);

    expect(ui.theme).toBe(theme);
    expect(() => ui.setStatus("k", "v")).not.toThrow();
    expect(() => ui.setWidget("k", undefined)).not.toThrow();
    expect(typeof ui.custom).toBe("function");
  });
});
