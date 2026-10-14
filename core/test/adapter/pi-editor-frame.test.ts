import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type EditorTheme,
  KeybindingsManager,
  type TUI,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorFrame, KeyPress } from "../../adapter/contract.ts";
import { createEditorHooks } from "../../adapter/pi-editor-frame.ts";

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

const ESC = String.fromCharCode(27);
const LEFT = `${ESC}[D`;
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

const bindings = (map: Record<string, string>) => ({
  matches: (data: string, id: string) => map[data] === id,
});

const keybindings = bindings({
  [LEFT]: "tui.editor.cursorLeft",
  [DOWN]: "tui.editor.cursorDown",
  [UP]: "tui.editor.cursorUp",
  [ESC]: "app.interrupt",
});

const editor = (factory: Factory, keys: object = keybindings) =>
  factory?.(tui, theme, keys as never) as unknown as CustomEditor;

const createEditorFrame = (tuiCtx: () => ExtensionContext | undefined) =>
  createEditorHooks(tuiCtx).setEditorFrame;

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

const EDITOR_KEY = Symbol.for("pi-extensions.editor-hooks.v1");

const piKeys = () => new KeybindingsManager(TUI_KEYBINDINGS);

/** A fresh module instance, as pi gives every extension through its own module cache. */
const adapterCopy = async () => {
  vi.resetModules();

  const copy = await import("../../adapter/pi-editor-frame.ts");

  return copy.createEditorHooks;
};

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[EDITOR_KEY];
});

describe("createEditorHooks", () => {
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

  it("installs the editor once and removes it when the frame is cleared and no hook remains", () => {
    const { ctx, ui } = fakeCtx();
    const hooks = createEditorHooks(() => ctx);

    hooks.setEditorFrame(frame);
    hooks.setEditorFrame(frame);

    const off = hooks.onEmptyEditorLeft(() => {});

    expect(ui.sets).toBe(1);

    hooks.setEditorFrame(undefined);

    expect(ui.sets).toBe(1);
    expect(ui.factory).toBeTypeOf("function");

    off();

    expect(ui.sets).toBe(2);
    expect(ui.factory).toBeUndefined();
  });

  it("renders the plain editor when only a key hook installed the editor", () => {
    const { ctx, ui } = fakeCtx();

    createEditorHooks(() => ctx).onEmptyEditorLeft(() => {});

    const hooked = editor(ui.factory);
    const plain = new CustomEditor(tui, theme, keybindings as never);

    hooked.setText("abc");
    plain.setText("abc");

    expect(hooked.render(30)).toEqual(plain.render(30));
  });

  it("fires the empty-left hook only for cursorLeft on an empty editor without autocomplete and consumes the key", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorLeft(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory);

    hooked.setText("a");
    hooked.handleInput(LEFT);

    expect(fired).toBe(0);
    expect(hooked.getCursor()).toEqual({ line: 0, col: 0 });

    hooked.setText("");

    const before = hooked.getCursor();

    hooked.handleInput(LEFT);

    expect(fired).toBe(1);
    expect(hooked.getCursor()).toEqual(before);
  });

  it("lets left reach the editor while autocomplete is open", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorLeft(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory);

    vi.spyOn(hooked, "isShowingAutocomplete").mockReturnValue(true);

    const reached = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});

    try {
      hooked.handleInput(LEFT);

      expect(fired).toBe(0);
      expect(reached).toHaveBeenCalledWith(LEFT);
    } finally {
      reached.mockRestore();
    }
  });

  it("lets left reach the editor while it waits for a jump target", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorLeft(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory);
    const pending = hooked as unknown as { jumpMode: "forward" | "backward" | null };

    pending.jumpMode = "forward";
    hooked.handleInput(LEFT);

    expect(fired).toBe(0);
    expect(pending.jumpMode).toBeNull();
  });

  it("routes keys to the capture, swallows consumed ones and lets a released key reach the editor", () => {
    const { ctx, ui } = fakeCtx();
    const seen: KeyPress[] = [];
    let escapes = 0;

    createEditorHooks(() => ctx).captureEditorKeys((key) => {
      seen.push(key);

      return key.name === "escape" ? "consumed" : "release";
    });

    const hooked = editor(ui.factory);

    hooked.onEscape = () => {
      escapes += 1;
    };

    hooked.handleInput(ESC);

    expect(escapes).toBe(0);
    expect(hooked.getText()).toBe("");

    hooked.handleInput("a");
    hooked.handleInput("b");

    expect(seen.map((key) => key.name)).toEqual(["escape", "other"]);
    expect(hooked.getText()).toBe("ab");

    hooked.handleInput(ESC);

    expect(escapes).toBe(1);
  });

  it("keeps up and down bound to pi's editor keybindings", () => {
    const { ctx, ui } = fakeCtx();
    const seen: KeyPress[] = [];
    const ctrlN = String.fromCharCode(14);

    createEditorHooks(() => ctx).captureEditorKeys((key) => {
      seen.push(key);

      return "consumed";
    });

    const hooked = editor(ui.factory, bindings({ [ctrlN]: "tui.editor.cursorDown" }));

    hooked.handleInput(ctrlN);
    hooked.handleInput(DOWN);

    expect(seen.map((key) => key.name)).toEqual(["down", "other"]);
  });

  it("installs at most one capture", () => {
    const { ctx, ui } = fakeCtx();
    const hooks = createEditorHooks(() => ctx);
    const first: string[] = [];
    const second: string[] = [];

    const offFirst = hooks.captureEditorKeys((key) => {
      first.push(key.raw ?? "");

      return "consumed";
    });

    hooks.captureEditorKeys((key) => {
      second.push(key.raw ?? "");

      return "consumed";
    });

    const hooked = editor(ui.factory);

    hooked.handleInput("x");
    offFirst();
    hooked.handleInput("y");

    expect(first).toEqual([]);
    expect(second).toEqual(["x", "y"]);
    expect(hooked.getText()).toBe("");
    expect(ui.sets).toBe(1);
  });

  it("registers no hook when another extension set the editor", () => {
    const { ctx, ui } = fakeCtx(() => ({}) as never);
    const hooks = createEditorHooks(() => ctx);

    hooks.onEmptyEditorLeft(() => {})();
    hooks.captureEditorKeys(() => "consumed")();

    expect(ui.sets).toBe(0);
  });

  it("does nothing outside tui mode", () => {
    const hooks = createEditorHooks(() => undefined);

    expect(() => hooks.setEditorFrame(frame)).not.toThrow();
    expect(() => hooks.onEmptyEditorLeft(() => {})()).not.toThrow();
    expect(() => hooks.captureEditorKeys(() => "consumed")()).not.toThrow();
  });

  it("keeps an empty-left hook registered before the session and installs the editor at session start", () => {
    const { ctx, ui } = fakeCtx();
    let current: ExtensionContext | undefined;
    let fired = 0;
    const hooks = createEditorHooks(() => current);

    hooks.onEmptyEditorLeft(() => {
      fired += 1;
    });

    expect(ui.sets).toBe(0);

    current = ctx;
    hooks.sync();

    expect(ui.sets).toBe(1);

    editor(ui.factory, piKeys()).handleInput(LEFT);

    expect(fired).toBe(1);
  });

  it("keeps a capture registered before the session and installs the editor at session start", () => {
    const { ctx, ui } = fakeCtx();
    let current: ExtensionContext | undefined;
    const seen: string[] = [];
    const hooks = createEditorHooks(() => current);

    hooks.captureEditorKeys((key) => {
      seen.push(key.name);

      return "consumed";
    });

    current = ctx;
    hooks.sync();
    editor(ui.factory, piKeys()).handleInput(DOWN);

    expect(seen).toEqual(["down"]);
  });

  it("installs nothing at session start when no frame or hook is registered", () => {
    const { ctx, ui } = fakeCtx();

    createEditorHooks(() => ctx).sync();

    expect(ui.sets).toBe(0);
  });

  it.each([
    ["the frame first", true],
    ["the hook first", false],
  ])("shares one editor between two adapter copies with %s", async (_, frameFirst) => {
    const { ctx, ui } = fakeCtx();
    const composer = (await adapterCopy())(() => ctx);
    const subagents = (await adapterCopy())(() => ctx);
    let fired = 0;

    const hook = () =>
      subagents.onEmptyEditorLeft(() => {
        fired += 1;
      });

    if (frameFirst) {
      composer.setEditorFrame(frame);
      hook();
    } else {
      hook();
      composer.setEditorFrame(frame);
    }

    const hooked = editor(ui.factory, piKeys());

    hooked.handleInput(LEFT);

    expect(ui.sets).toBe(1);
    expect(fired).toBe(1);
    expect(hooked.render(20)[1]?.startsWith("<|>>  ")).toBe(true);
  });

  it.each([
    ["the frame first", true],
    ["the capture first", false],
  ])("routes a capture from another adapter copy to the shared editor with %s", async (_, frameFirst) => {
    const { ctx, ui } = fakeCtx();
    const composer = (await adapterCopy())(() => ctx);
    const subagents = (await adapterCopy())(() => ctx);
    const seen: string[] = [];

    const capture = () =>
      subagents.captureEditorKeys((key) => {
        seen.push(key.name);

        return "consumed";
      });

    if (frameFirst) {
      composer.setEditorFrame(frame);
      capture();
    } else {
      capture();
      composer.setEditorFrame(frame);
    }

    const hooked = editor(ui.factory, piKeys());

    hooked.handleInput(UP);

    expect(ui.sets).toBe(1);
    expect(seen).toEqual(["up"]);
    expect(hooked.render(20)[1]?.startsWith("<|>>  ")).toBe(true);
  });

  it("drops only this copy's frame and hooks at shutdown and removes the editor when none remain", async () => {
    const { ctx, ui } = fakeCtx();
    const composer = (await adapterCopy())(() => ctx);
    const subagents = (await adapterCopy())(() => ctx);
    let fired = 0;

    composer.setEditorFrame(frame);
    subagents.onEmptyEditorLeft(() => {
      fired += 1;
    });
    subagents.captureEditorKeys(() => "release");

    subagents.release();

    const hooked = editor(ui.factory, piKeys());

    hooked.handleInput(LEFT);

    expect(fired).toBe(0);
    expect(hooked.render(20)[1]?.startsWith("<|>>  ")).toBe(true);

    composer.release();

    expect(ui.factory).toBeUndefined();
  });

  it("keeps the hooks of the new extensions after a reload", async () => {
    const { ctx, ui } = fakeCtx();
    const old = (await adapterCopy())(() => ctx);
    let fired = "";

    old.onEmptyEditorLeft(() => {
      fired += "old";
    });
    old.release();

    let current: ExtensionContext | undefined;
    const fresh = (await adapterCopy())(() => current);

    fresh.onEmptyEditorLeft(() => {
      fired += "new";
    });
    current = ctx;
    fresh.sync();
    editor(ui.factory, piKeys()).handleInput(LEFT);

    expect(fired).toBe("new");
  });
});
