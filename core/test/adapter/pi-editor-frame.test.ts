import type { CustomEditor, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { EditorFrame } from "../../adapter/contract.ts";
import { createEditorFrame } from "../../adapter/pi-editor-frame.ts";

type Factory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

const fakeCtx = (existing?: Factory) => {
  const ui = { factory: existing, sets: 0 };
  const ctx = {
    ui: {
      getEditorComponent: () => ui.factory,
      setEditorComponent: (factory: Factory) => {
        ui.factory = factory;
        ui.sets += 1;
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, ui };
};

const tui = { terminal: { rows: 40 }, requestRender: () => {} } as unknown as TUI;
const theme = { borderColor: (text: string) => `<${text}>`, selectList: {} } as unknown as EditorTheme;

const frame: EditorFrame = {
  chrome: 6,
  left: 4,
  minWidth: 14,
  decorate: (lines, { bottom, scrolled }, paint) =>
    lines.map((line, index) => {
      if (index > bottom) {
        return `    ${line}`;
      }

      return `${paint("|")}${index === 1 && !scrolled ? ">" : " "}  ${line} ${paint("|")}`;
    }),
};

const editor = (factory: Factory) => factory?.(tui, theme, {} as never) as unknown as CustomEditor;

const render = (factory: Factory, width: number) => editor(factory)?.render(width) ?? [];

const click = (x: number, y: number, width: number) => ({
  type: "click" as const,
  button: "left" as const,
  x,
  y,
  screenX: x,
  screenY: y,
  width,
  height: 10,
  shift: false,
  alt: false,
  ctrl: false,
  clickCount: 1,
});

describe("createEditorFrame", () => {
  it("renders the editor narrower and decorates it with the border colour", () => {
    const { ctx, ui } = fakeCtx();

    createEditorFrame(() => ctx)(frame);

    const lines = render(ui.factory, 20);

    expect(ui.sets).toBe(1);
    expect(lines[0]).toBe(`<|>   <${"─".repeat(14)}> <|>`);
    expect(lines[1]?.startsWith("<|>>  ")).toBe(true);
    expect(lines.every((line) => line.startsWith("<|>") && line.endsWith("<|>"))).toBe(true);
  });

  it("falls back to the plain editor below the minimum width", () => {
    const { ctx, ui } = fakeCtx();

    createEditorFrame(() => ctx)(frame);

    expect(render(ui.factory, 13)[0]).toBe(`<${"─".repeat(13)}>`);
  });

  it("keeps every line as wide as the terminal and hides the chevron while scrolled", () => {
    const { ctx, ui } = fakeCtx();
    const plainTheme = { borderColor: (text: string) => text, selectList: {} } as unknown as EditorTheme;

    createEditorFrame(() => ctx)(frame);

    const framed = ui.factory?.(tui, plainTheme, {} as never) as unknown as CustomEditor;

    framed.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"));

    const lines = framed.render(30);

    expect(lines[0]).toContain("↑");
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    expect(lines.some((line) => line.includes(">"))).toBe(false);
  });

  it("shifts mouse clicks left by the frame so they land on the clicked character", () => {
    const { ctx, ui } = fakeCtx();

    createEditorFrame(() => ctx)(frame);

    const framed = editor(ui.factory);

    framed.setText("abcdef");
    framed.render(30);

    expect(framed.handleMouse(click(frame.left + 2, 1, 30))).toEqual({ handled: true, focus: true });
    expect(framed.getCursor()).toEqual({ line: 0, col: 2 });
  });

  it("does not replace an editor another extension set", () => {
    const { ctx, ui } = fakeCtx(() => ({}) as never);

    createEditorFrame(() => ctx)(frame);

    expect(ui.sets).toBe(0);
  });

  it("reinstalls its own editor when set again and removes it on undefined", () => {
    const { ctx, ui } = fakeCtx();
    const setFrame = createEditorFrame(() => ctx);

    setFrame(frame);
    setFrame(frame);

    expect(ui.sets).toBe(2);
    expect(ui.factory).toBeTypeOf("function");

    setFrame(undefined);

    expect(ui.sets).toBe(3);
    expect(ui.factory).toBeUndefined();
  });

  it("does nothing outside tui mode", () => {
    expect(() => createEditorFrame(() => undefined)(frame)).not.toThrow();
  });
});
