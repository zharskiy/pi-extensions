import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { EditorFrame } from "../../adapter/contract.ts";
import { createEditorFrame } from "../../adapter/pi-editor-frame.ts";

type Factory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

const fakeCtx = (mode: string, existing?: Factory) => {
  const ui = { factory: existing, sets: 0 };
  const ctx = {
    mode,
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
  chrome: 4,
  minWidth: 10,
  decorate: (lines, paint) => lines.map((line) => paint("|") + line),
};

const render = (factory: Factory, width: number) => factory?.(tui, theme, {} as never).render(width) ?? [];

describe("createEditorFrame", () => {
  it("renders the editor narrower and decorates it with the border colour", () => {
    const { ctx, ui } = fakeCtx("tui");

    expect(createEditorFrame(() => ctx)(frame)).toBe(true);

    const lines = render(ui.factory, 20);

    expect(lines[0]).toBe(`<|><${"─".repeat(16)}>`);
    expect(lines.every((line) => line.startsWith("<|>"))).toBe(true);
  });

  it("falls back to the plain editor below the minimum width", () => {
    const { ctx, ui } = fakeCtx("tui");

    createEditorFrame(() => ctx)(frame);

    expect(render(ui.factory, 9)[0]).toBe(`<${"─".repeat(9)}>`);
  });

  it("does not replace an editor another extension set", () => {
    const { ctx, ui } = fakeCtx("tui", () => ({}) as never);

    expect(createEditorFrame(() => ctx)(frame)).toBe(false);
    expect(ui.sets).toBe(0);
  });

  it("keeps its own editor when set again and removes it on undefined", () => {
    const { ctx, ui } = fakeCtx("tui");
    const setFrame = createEditorFrame(() => ctx);

    setFrame(frame);
    setFrame(frame);

    expect(ui.sets).toBe(1);
    expect(setFrame(undefined)).toBe(true);
    expect(ui.factory).toBeUndefined();
  });

  it("does nothing outside tui mode", () => {
    expect(createEditorFrame(() => undefined)(frame)).toBe(false);
  });
});
