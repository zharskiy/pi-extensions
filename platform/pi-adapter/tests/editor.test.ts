import { CustomEditor, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type EditorTheme,
  KeybindingsManager,
  type TUI,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorHooks } from "../editor/editor.ts";
import type { EditorFrame, KeyPress, ThemeToken } from "../index.ts";

type Factory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];

const userEntry = (content: string | { type: string; text?: string }[]) => ({
  type: "message",
  message: { role: "user", content },
});

const frameTheme = {
  fg: (token: string, text: string) => `<${token}:${text}>`,
  bold: (text: string) => text,
} as unknown as Theme;

const fakeCtx = (existing?: Factory, entries: object[] = []) => {
  const ui = { factory: existing, sets: 0, idle: true };
  const ctx = {
    isIdle: () => ui.idle,
    sessionManager: { buildContextEntries: () => entries },
    ui: {
      theme: frameTheme,
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
const JUMP = String.fromCharCode(29);
const BACKSPACE = String.fromCharCode(127);

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

const EDITOR_KEY = Symbol.for("pi-extensions.editor-hooks");

const piKeys = () => new KeybindingsManager(TUI_KEYBINDINGS);

const historyOf = (hooked: CustomEditor) => (hooked as unknown as { history: string[] }).history;

const adapterCopy = async () => {
  vi.resetModules();

  const copy = await import("../editor/editor.ts");

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

  it("hands the frame the session's theme", () => {
    const { ctx, ui } = fakeCtx();
    const painted: string[] = [];

    createEditorFrame(() => ctx)({
      ...frame,
      decorate: (lines, layout, paint, theme) => {
        painted.push(theme.fg("accent", "›"));

        return frame.decorate(lines, layout, paint, theme);
      },
    });
    render(ui.factory, 20);

    expect(painted.at(-1)).toBe("<accent:›>");
  });

  it("decorates with the border colour pi sets when the thinking level changes", () => {
    const { ctx, ui } = fakeCtx();

    createEditorFrame(() => ctx)(frame);

    const framed = editor(ui.factory);
    const prompt = (token: ThemeToken) => {
      framed.borderColor = (text) => frameTheme.fg(token, text);

      return framed.render(20)[1];
    };

    expect(prompt("thinkingOff")?.startsWith("<thinkingOff:|>>")).toBe(true);
    expect(prompt("thinkingMedium")?.startsWith("<thinkingMedium:|>>")).toBe(true);
    expect(prompt("thinkingMax")?.startsWith("<thinkingMax:|>>")).toBe(true);
  });

  it("builds pi's editor with the working status embedded", () => {
    const { ctx, ui } = fakeCtx();

    createEditorFrame(() => ctx)(frame);

    expect(editor(ui.factory).embedWorkingStatus).toBe(true);
  });

  it("draws pi's working status in the framed top rule and keeps a plain rule otherwise", () => {
    const { ctx, ui } = fakeCtx();

    createEditorFrame(() => ctx)(frame);

    const framed = editor(ui.factory);
    const plain = framed.render(40);

    framed.setWorkingStatusIndicator({
      renderInBorder: () => "⠹ Working",
      renderSpinnerInBorder: () => "⠹",
    } as never);

    const working = framed.render(40);

    expect(plain[0]).not.toContain("Working");
    expect(working[0]).toContain("⠹ Working");
    expect(working[0]?.endsWith("<|>")).toBe(true);
    expect(working[1]?.startsWith("<|>>  ")).toBe(true);
    expect(working.length).toBe(plain.length);
    expect(working.filter((line) => line.includes("──")).length).toBe(2);
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

    hooked.handleInput(JUMP);
    hooked.handleInput(LEFT);

    expect(fired).toBe(0);

    hooked.handleInput(LEFT);

    expect(fired).toBe(1);
  });

  it("fires the empty-down hook on an empty editor with pi's keybindings and consumes the key", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorDown(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory, piKeys());
    const reached = vi.spyOn(CustomEditor.prototype, "handleInput");

    try {
      hooked.handleInput(DOWN);

      expect(fired).toBe(1);
      expect(reached).not.toHaveBeenCalled();
    } finally {
      reached.mockRestore();
    }
  });

  it("lets down reach the editor when the editor has text", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorDown(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory, piKeys());

    hooked.setText("abc");
    hooked.handleInput(LEFT);
    hooked.handleInput(DOWN);

    expect(fired).toBe(0);
    expect(hooked.getCursor()).toEqual({ line: 0, col: 3 });
  });

  it("lets down browse input history back to the empty draft before it fires", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorDown(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory, piKeys());

    hooked.addToHistory("first");
    hooked.addToHistory("second");
    hooked.handleInput(UP);
    hooked.handleInput(UP);

    expect(hooked.getText()).toBe("first");

    hooked.handleInput(DOWN);

    expect(hooked.getText()).toBe("second");

    hooked.handleInput(DOWN);

    expect(hooked.getText()).toBe("");
    expect(fired).toBe(0);

    hooked.handleInput(DOWN);

    expect(fired).toBe(1);
  });

  it("does not fire with a non-empty draft after browsing history", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorDown(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory, piKeys());

    hooked.addToHistory("first");
    hooked.handleInput("d");
    hooked.handleInput(UP);
    hooked.handleInput(DOWN);
    hooked.handleInput(DOWN);

    expect(hooked.getText()).toBe("d");
    expect(fired).toBe(0);
  });

  it("lets down reach the editor while autocomplete is open or a jump target is pending", () => {
    const { ctx, ui } = fakeCtx();
    let fired = 0;

    createEditorHooks(() => ctx).onEmptyEditorDown(() => {
      fired += 1;
    });

    const hooked = editor(ui.factory, piKeys());
    const autocomplete = vi.spyOn(hooked, "isShowingAutocomplete").mockReturnValue(true);
    const reached = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});

    try {
      hooked.handleInput(DOWN);

      expect(reached).toHaveBeenCalledWith(DOWN);
    } finally {
      reached.mockRestore();
    }

    autocomplete.mockReturnValue(false);
    hooked.handleInput(JUMP);
    hooked.handleInput(DOWN);

    expect(fired).toBe(0);

    hooked.handleInput(DOWN);

    expect(fired).toBe(1);
  });

  it("gives down to a capture first and to the empty-down hook once the capture releases it", () => {
    const { ctx, ui } = fakeCtx();
    const hooks = createEditorHooks(() => ctx);
    let fired = 0;
    let outcome: "consumed" | "release" = "consumed";

    hooks.onEmptyEditorDown(() => {
      fired += 1;
    });
    hooks.captureEditorKeys(() => outcome);

    const hooked = editor(ui.factory, piKeys());

    hooked.handleInput(DOWN);

    expect(fired).toBe(0);

    outcome = "release";
    hooked.handleInput(DOWN);

    expect(fired).toBe(1);
  });

  it("gives left to a capture first and to the empty-left hook once the capture releases it", () => {
    const { ctx, ui } = fakeCtx();
    const hooks = createEditorHooks(() => ctx);
    let fired = 0;
    let outcome: "consumed" | "release" = "consumed";

    hooks.onEmptyEditorLeft(() => {
      fired += 1;
    });
    hooks.captureEditorKeys(() => outcome);

    const hooked = editor(ui.factory, piKeys());

    hooked.handleInput(LEFT);

    expect(fired).toBe(0);

    outcome = "release";
    hooked.handleInput(LEFT);

    expect(fired).toBe(1);
  });

  it("consumes the interrupt key on an empty idle editor only when an escape hook takes it", () => {
    const { ctx, ui } = fakeCtx();
    const answers = [false, true];
    let asked = 0;

    createEditorHooks(() => ctx).onEmptyEditorEscape(() => {
      asked += 1;

      return answers.shift() ?? false;
    });

    const hooked = editor(ui.factory);
    const reached = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});

    try {
      hooked.handleInput(ESC);

      expect(asked).toBe(1);
      expect(reached).toHaveBeenCalledTimes(1);

      hooked.handleInput(ESC);

      expect(asked).toBe(2);
      expect(reached).toHaveBeenCalledTimes(1);
    } finally {
      reached.mockRestore();
    }
  });

  it("leaves the interrupt key to pi with a draft, with autocomplete open or while pi is busy", () => {
    const { ctx, ui } = fakeCtx();
    let asked = 0;

    createEditorHooks(() => ctx).onEmptyEditorEscape(() => {
      asked += 1;

      return true;
    });

    const hooked = editor(ui.factory);
    const reached = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});
    const autocomplete = vi.spyOn(hooked, "isShowingAutocomplete");

    try {
      hooked.setText("draft");
      hooked.handleInput(ESC);
      hooked.setText("");
      autocomplete.mockReturnValue(true);
      hooked.handleInput(ESC);
      autocomplete.mockReturnValue(false);
      ui.idle = false;
      hooked.handleInput(ESC);

      expect(asked).toBe(0);
      expect(reached).toHaveBeenCalledTimes(3);
    } finally {
      reached.mockRestore();
      autocomplete.mockRestore();
    }
  });

  it("hands the interrupt key to the escape hook after typed text is deleted", () => {
    const { ctx, ui } = fakeCtx();
    let asked = 0;

    createEditorHooks(() => ctx).onEmptyEditorEscape(() => {
      asked += 1;

      return true;
    });

    const keys = piKeys();
    const matches = keys.matches.bind(keys);

    keys.matches = (data, id) => (id === "app.interrupt" ? data === ESC : matches(data, id));

    const hooked = editor(ui.factory, keys);

    hooked.handleInput("a");
    hooked.handleInput(ESC);

    expect(hooked.getText()).toBe("a");
    expect(asked).toBe(0);

    hooked.handleInput(BACKSPACE);
    hooked.handleInput(ESC);

    expect(hooked.getText()).toBe("");
    expect(asked).toBe(1);
  });

  it("follows a rebound interrupt key, not the escape byte", () => {
    const { ctx, ui } = fakeCtx();
    let asked = 0;

    createEditorHooks(() => ctx).onEmptyEditorEscape(() => {
      asked += 1;

      return true;
    });

    const hooked = editor(ui.factory, bindings({ [JUMP]: "app.interrupt" }));
    const reached = vi.spyOn(CustomEditor.prototype, "handleInput").mockImplementation(() => {});

    try {
      hooked.handleInput(ESC);

      expect(asked).toBe(0);

      hooked.handleInput(JUMP);

      expect(asked).toBe(1);
      expect(reached).toHaveBeenCalledTimes(1);
    } finally {
      reached.mockRestore();
    }
  });

  it("stops asking once the escape hook is removed and frees the editor on release", () => {
    const { ctx, ui } = fakeCtx();
    const hooks = createEditorHooks(() => ctx);
    let asked = 0;

    const off = hooks.onEmptyEditorEscape(() => {
      asked += 1;

      return true;
    });

    expect(ui.factory).toBeDefined();

    off();

    expect(ui.factory).toBeUndefined();

    hooks.onEmptyEditorEscape(() => {
      asked += 1;

      return true;
    });

    const hooked = editor(ui.factory);

    hooks.release();
    hooked.handleInput(ESC);

    expect(asked).toBe(0);
    expect(ui.factory).toBeUndefined();
  });

  it("keeps the left and down hooks independent", () => {
    const { ctx, ui } = fakeCtx();
    const hooks = createEditorHooks(() => ctx);
    const fired: string[] = [];

    hooks.onEmptyEditorLeft(() => {
      fired.push("left");
    });
    const offDown = hooks.onEmptyEditorDown(() => {
      fired.push("down");
    });

    const hooked = editor(ui.factory, piKeys());

    hooked.handleInput(LEFT);
    hooked.handleInput(DOWN);
    offDown();
    hooked.handleInput(DOWN);
    hooked.handleInput(LEFT);

    expect(fired).toEqual(["left", "down", "left"]);
    expect(ui.factory).toBeDefined();
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
    hooks.onEmptyEditorDown(() => {})();
    hooks.captureEditorKeys(() => "consumed")();

    expect(ui.sets).toBe(0);
  });

  it("does nothing outside tui mode", () => {
    const hooks = createEditorHooks(() => undefined);

    expect(() => hooks.setEditorFrame(frame)).not.toThrow();
    expect(() => hooks.onEmptyEditorLeft(() => {})()).not.toThrow();
    expect(() => hooks.onEmptyEditorDown(() => {})()).not.toThrow();
    expect(() => hooks.captureEditorKeys(() => "consumed")()).not.toThrow();
  });

  it("installs nothing at session start when no frame or hook is registered", () => {
    const { ctx, ui } = fakeCtx();

    createEditorHooks(() => ctx).sync("startup");

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
      subagents.onEmptyEditorDown(() => {
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

    hooked.handleInput(DOWN);

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
    subagents.onEmptyEditorDown(() => {
      fired += 1;
    });
    subagents.captureEditorKeys(() => "release");

    subagents.release();

    const hooked = editor(ui.factory, piKeys());

    hooked.handleInput(LEFT);
    hooked.handleInput(DOWN);

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
    fresh.sync("reload");
    editor(ui.factory, piKeys()).handleInput(LEFT);

    expect(fired).toBe("new");
  });

  it("recalls submitted input when an older copy left a record without history", () => {
    (globalThis as Record<symbol, unknown>)[EDITOR_KEY] = { emptyLeft: new Set(), emptyDown: new Set() };

    const { ctx, ui } = fakeCtx();

    createEditorHooks(() => ctx).setEditorFrame(frame);

    const hooked = editor(ui.factory, piKeys());

    hooked.addToHistory("sent");
    hooked.handleInput(UP);

    expect(hooked.getText()).toBe("sent");
  });

  it("keeps input history when pi rebuilds the editor after a reload", async () => {
    const { ctx, ui } = fakeCtx();
    const first = createEditorHooks(() => ctx);

    first.setEditorFrame(frame);

    const before = editor(ui.factory, piKeys());

    before.addToHistory("first");
    before.addToHistory("second");
    first.release();
    ui.factory = undefined;

    const second = (await adapterCopy())(() => ctx);

    second.setEditorFrame(frame);

    const after = editor(ui.factory, piKeys());

    after.handleInput(UP);

    expect(after.getText()).toBe("second");

    after.handleInput(UP);

    expect(after.getText()).toBe("first");
  });

  it.each([
    ["resume", "at session start", true],
    ["fork", "at session start", true],
    ["resume", "by a start handler", false],
  ] as const)(
    "adds the %s session's user messages when the editor is installed %s",
    async (reason, _, early) => {
      const prior = fakeCtx();
      const first = createEditorHooks(() => prior.ctx);

      first.setEditorFrame(frame);
      editor(prior.ui.factory, piKeys()).addToHistory("prior");
      first.release();

      const { ctx, ui } = fakeCtx(undefined, [
        userEntry("one"),
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
        { type: "custom", customType: "note" },
        userEntry([{ type: "text", text: "tw" }, { type: "image" }, { type: "text", text: "o" }]),
      ]);
      let current: ExtensionContext | undefined;
      const fresh = (await adapterCopy())(() => current);

      if (early) {
        fresh.setEditorFrame(frame);
      }

      current = ctx;
      fresh.sync(reason);

      if (!early) {
        fresh.setEditorFrame(frame);
      }

      const resumed = editor(ui.factory, piKeys());

      resumed.handleInput(UP);

      expect(resumed.getText()).toBe("two");

      resumed.handleInput(UP);

      expect(resumed.getText()).toBe("one");

      resumed.handleInput(UP);

      expect(resumed.getText()).toBe("prior");
      expect(historyOf(resumed)).toEqual(["two", "one", "prior"]);
    },
  );

  it("adds the resumed session's messages only once across adapter copies", async () => {
    const { ctx, ui } = fakeCtx(undefined, [userEntry("one"), userEntry("two")]);
    let current: ExtensionContext | undefined;
    const composer = (await adapterCopy())(() => current);
    const subagents = (await adapterCopy())(() => current);

    subagents.onEmptyEditorLeft(() => {});
    current = ctx;
    subagents.sync("resume");
    editor(ui.factory, piKeys());
    composer.sync("resume");
    composer.setEditorFrame(frame);
    subagents.release();
    composer.release();
    ui.factory = undefined;
    composer.setEditorFrame(frame);

    expect(historyOf(editor(ui.factory, piKeys()))).toEqual(["two", "one"]);
  });

  it.each(["startup", "reload", "new"] as const)("adds no session messages on %s", async (reason) => {
    const prior = fakeCtx();
    const first = createEditorHooks(() => prior.ctx);

    first.setEditorFrame(frame);
    editor(prior.ui.factory, piKeys()).addToHistory("prior");
    first.release();

    const { ctx, ui } = fakeCtx(undefined, [userEntry("prior"), userEntry("one")]);
    const fresh = (await adapterCopy())(() => ctx);

    fresh.sync(reason);
    fresh.setEditorFrame(frame);

    expect(historyOf(editor(ui.factory, piKeys()))).toEqual(["prior"]);
  });
});
