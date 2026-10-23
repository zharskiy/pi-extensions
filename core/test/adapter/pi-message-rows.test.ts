import {
  AssistantMessageComponent,
  getMarkdownTheme,
  type Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installMessageRows, uninstallMessageRows } from "../../adapter/pi-message-rows.ts";
import { initRenderTheme } from "./render-theme.ts";

const themeModule = await import(
  new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
);

const theme = () => themeModule.theme as Theme;

const WIDTH = 40;

const OSC_A = "\x1b]133;A\x07";
const OSC_BC = "\x1b]133;B\x07\x1b]133;C\x07";

const visible = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

const assistant = (content: unknown[], stopReason = "stop", errorMessage?: string) =>
  ({ role: "assistant", content, stopReason, errorMessage, timestamp: 0 }) as never;

const click = (y: number, width: number, height: number): TuiMouseEvent => ({
  type: "click",
  button: "left",
  x: 4,
  y,
  screenX: 4,
  screenY: y,
  width,
  height,
  shift: false,
  alt: false,
  ctrl: false,
  clickCount: 1,
});

beforeAll(() => {
  initRenderTheme();
});

afterEach(() => {
  uninstallMessageRows();
});

describe("user rows", () => {
  it("puts the prompt glyph after the pad and fills every line of the width with the user background", () => {
    installMessageRows(theme);

    const lines = new UserMessageComponent(
      "fix the bug in the parser and run every test again",
      getMarkdownTheme(),
    ).render(WIDTH);
    const bg = theme().getBgAnsi("userMessageBg");
    const text = visible(lines);

    expect(text[0]?.startsWith(" ❯ fix the bug")).toBe(true);
    expect(text.slice(1).every((line) => line.startsWith("   "))).toBe(true);
    expect(text.every((line) => line.trim() !== "")).toBe(true);
    expect(lines.every((line) => visibleWidth(line) === WIDTH)).toBe(true);
    expect(lines.every((line) => line.includes(bg))).toBe(true);
    expect(lines[0]?.startsWith(OSC_A)).toBe(true);
    expect(lines.at(-1)?.startsWith(OSC_BC)).toBe(true);
    expect(lines[0]).toContain(theme().fg("muted", "❯"));
  });
});

describe("assistant rows", () => {
  const message = assistant(
    [
      { type: "thinking", thinking: "look at the parser" },
      { type: "text", text: "The parser skips the first token." },
    ],
    "error",
    "boom",
  );

  it("marks a thinking run, the text and the error notice in order", () => {
    installMessageRows(theme);

    const lines = new AssistantMessageComponent(message, false, getMarkdownTheme()).render(WIDTH);
    const text = visible(lines);
    const thinking = text.findIndex((line) => line.startsWith(" ∴ look at the parser"));
    const answer = text.findIndex((line) => line.startsWith(" ● The parser"));
    const error = text.findIndex((line) => line.startsWith(" ● Error: boom"));

    expect(thinking).toBeGreaterThan(0);
    expect(answer).toBeGreaterThan(thinking);
    expect(error).toBeGreaterThan(answer);
    expect(lines[answer]).toContain(theme().fg("text", "●"));
    expect(lines[error]).toContain(theme().fg("error", "●"));
    expect(lines[thinking]).toContain(theme().fg("dim", "∴"));
  });

  it("draws a hidden thinking label that already carries the glyph unchanged", () => {
    installMessageRows(theme);

    const text = visible(
      new AssistantMessageComponent(message, true, getMarkdownTheme(), "∴ Thinking…").render(WIDTH),
    );

    expect(text.filter((line) => line.includes("∴"))).toEqual([" ∴ Thinking…"]);
  });

  it("toggles a thinking run on a click at the full width", () => {
    installMessageRows(theme);

    const component = new AssistantMessageComponent(message, true, getMarkdownTheme(), "∴ Thinking…");
    const before = component.render(WIDTH);
    const row = visible(before).indexOf(" ∴ Thinking…");
    const result = component.handleMouse?.(click(row, WIDTH, before.length));

    expect(result?.handled).toBe(true);
    expect(visible(component.render(WIDTH)).some((line) => line.startsWith(" ∴ look at the parser"))).toBe(
      true,
    );
  });

  it("leaves pi's look when no theme is available and after uninstalling", () => {
    const user = () => new UserMessageComponent("fix the bug", getMarkdownTheme()).render(WIDTH);
    const reply = () => new AssistantMessageComponent(message, false, getMarkdownTheme()).render(WIDTH);
    const piLook = [user(), reply()];

    installMessageRows(() => undefined);

    expect([user(), reply()]).toEqual(piLook);

    installMessageRows(theme);

    expect([user(), reply()]).not.toEqual(piLook);

    uninstallMessageRows();

    expect([user(), reply()]).toEqual(piLook);
  });

  it("draws pi's own lines when a row render throws", () => {
    const user = () => new UserMessageComponent("fix the bug", getMarkdownTheme()).render(WIDTH);
    const piLook = user();
    const broken = Object.create(theme(), {
      bg: {
        value: () => {
          throw new Error("broken theme");
        },
      },
    }) as Theme;

    installMessageRows(() => broken);

    expect(user()).toEqual(piLook);
  });

  it("keeps the rows until every owner has uninstalled", () => {
    const user = () => new UserMessageComponent("fix the bug", getMarkdownTheme()).render(WIDTH);
    const piLook = user();
    const first = {};
    const second = {};

    installMessageRows(theme, first);
    installMessageRows(theme, second);
    uninstallMessageRows(second);

    expect(user()).not.toEqual(piLook);

    uninstallMessageRows(second);
    uninstallMessageRows(first);

    expect(user()).toEqual(piLook);
  });
});

describe("message rows fallbacks and widths", () => {
  const message = assistant([{ type: "text", text: "The parser skips the first token of every line." }]);

  const piLookOf = (build: () => { render(width: number): string[] }, width: number) => {
    uninstallMessageRows();

    const lines = build().render(width);

    installMessageRows(theme);

    return lines;
  };

  it("draws pi's own lines for an assistant message of another shape", () => {
    const extraChild = () => {
      const component = new AssistantMessageComponent(message, false, getMarkdownTheme());

      component.addChild(new Text("extra", 0, 0));

      return component;
    };
    const noContainer = () => {
      const component = new AssistantMessageComponent(message, false, getMarkdownTheme());

      component.children[0] = new Text("flat", 0, 0);

      return component;
    };

    installMessageRows(theme);

    expect(extraChild().render(WIDTH)).toEqual(piLookOf(extraChild, WIDTH));
    expect(noContainer().render(WIDTH)).toEqual(piLookOf(noContainer, WIDTH));
  });

  it("draws pi's own lines at three columns or less", () => {
    const reply = () => new AssistantMessageComponent(message, false, getMarkdownTheme());
    const user = () => new UserMessageComponent("hi", getMarkdownTheme());

    installMessageRows(theme);

    expect(reply().render(3)).toEqual(piLookOf(reply, 3));
    expect(user().render(3)).toEqual(piLookOf(user, 3));
  });

  it("puts the prompt glyph at the first column without an output pad", () => {
    installMessageRows(theme);

    const text = visible(new UserMessageComponent("fix it", getMarkdownTheme(), 0).render(WIDTH));

    expect(text).toEqual(["❯ fix it"]);
  });

  it("keeps both rows inside a narrow width", () => {
    installMessageRows(theme);

    const user = new UserMessageComponent("fix the parser and run the tests", getMarkdownTheme()).render(20);
    const reply = new AssistantMessageComponent(message, false, getMarkdownTheme()).render(20);

    expect(user.every((line) => visibleWidth(line) === 20)).toBe(true);
    expect(visible(user)[0]?.startsWith(" ❯ fix")).toBe(true);
    expect(reply.every((line) => visibleWidth(line) <= 20)).toBe(true);
    expect(visible(reply)[1]?.startsWith(" ● The parser")).toBe(true);
    expect(
      visible(reply)
        .slice(2)
        .every((line) => line.startsWith("   ")),
    ).toBe(true);
  });
});
