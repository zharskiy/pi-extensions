import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { KeyPress, ViewComponent } from "../../adapter/contract.ts";
import { createEditorHooks } from "../../adapter/pi-editor.ts";
import { createUi, type HostState, notificationSequence } from "../../adapter/pi-ui.ts";

const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

const keyContext = (mode: string) => {
  const inputs: ((data: string) => unknown)[] = [];
  const removed: number[] = [];
  const state: HostState = {
    ctx: {
      mode,
      ui: {
        onTerminalInput: (handler: (data: string) => unknown) => {
          inputs.push(handler);
          return () => {
            removed.push(inputs.indexOf(handler));
          };
        },
      },
    } as unknown as ExtensionContext,
  };

  return {
    ui: createUi(
      state,
      { write: () => {} },
      {},
      createEditorHooks(() => undefined),
    ),
    inputs,
    removed,
  };
};

describe("onKeyPress", () => {
  it("onKeyPress calls the listener for keys, skips SGR and X10 mouse reports and key releases, and never consumes", () => {
    const { ui, inputs, removed } = keyContext("tui");
    let presses = 0;

    const off = ui.onKeyPress(() => {
      presses += 1;
    });

    const results = ["a", `${ESC}[A`, `${ESC}[<0;10;5M`, `${ESC}[M abc`, `${ESC}[97;1:3u`, "\r"].map((data) =>
      inputs[0]?.(data),
    );

    off();

    expect(inputs).toHaveLength(1);
    expect(presses).toBe(3);
    expect(results).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(removed).toEqual([0]);
  });

  it("onKeyPress is a no-op outside tui", () => {
    const silent = ["rpc", "print", "json"].map((mode) => {
      const { ui, inputs } = keyContext(mode);
      const off = ui.onKeyPress(() => {});

      off();

      return inputs.length;
    });

    expect(silent).toEqual([0, 0, 0]);
  });
});

const captured = (mode: string, env = {}) => {
  const writes: string[] = [];
  const state: HostState = { ctx: { mode } as unknown as ExtensionContext };
  const ui = createUi(
    state,
    { write: (data: string) => writes.push(data) },
    env,
    createEditorHooks(() => undefined),
  );

  return { ui, writes, state };
};

describe("terminalNotify", () => {
  it("writes one OSC 9 notification without a bell in tui mode", () => {
    const { ui, writes } = captured("tui", { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" });

    ui.terminalNotify("pi is waiting for your input", "auto");

    expect(writes).toEqual([`${ESC}]9;pi is waiting for your input${BEL}`]);
  });

  it("writes OSC 777 titled pi for rxvt terminals", () => {
    const { ui, writes } = captured("tui", { TERM: "rxvt-unicode-256color" });

    ui.terminalNotify("pi is waiting for your input", "auto");

    expect(writes).toEqual([`${ESC}]777;notify;pi;pi is waiting for your input${BEL}`]);
  });

  it("writes only the bell for the bell channel", () => {
    const ghostty = captured("tui", { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" });
    const rxvt = captured("tui", { TERM: "rxvt-unicode-256color" });

    ghostty.ui.terminalNotify("pi is waiting for your input", "bell");
    rxvt.ui.terminalNotify("pi is waiting for your input", "bell");

    expect(ghostty.writes).toEqual([BEL]);
    expect(rxvt.writes).toEqual([BEL]);
  });

  it("writes nothing in rpc, print or json mode, or once the session is stale", () => {
    const silent = ["rpc", "print", "json"].map((mode) => {
      const { ui, writes } = captured(mode);

      ui.terminalNotify("message", "auto");
      ui.terminalNotify("message", "bell");

      return writes.length;
    });

    const stale = captured("tui");

    stale.state.ctx = undefined;
    stale.ui.terminalNotify("message", "auto");
    stale.ui.terminalNotify("message", "bell");

    expect(silent).toEqual([0, 0, 0]);
    expect(stale.writes).toEqual([]);
  });

  it("replaces control characters in the message", () => {
    const message = `a${ESC}]0;x\nline${BEL}`;

    expect(notificationSequence(message, "auto", {})).toBe(`${ESC}]9;a ]0;x line${BEL}`);
    expect(notificationSequence(message, "auto", { TERM_PROGRAM: "urxvt" })).toBe(
      `${ESC}]777;notify;pi;a ]0;x line${BEL}`,
    );
  });
});

type OverlayComponent = { handleMouse(event: object): unknown; handleInput(data: string): void };

const ARROW_BINDINGS: Record<string, string> = {
  [`${ESC}[A`]: "tui.editor.cursorUp",
  [`${ESC}[B`]: "tui.editor.cursorDown",
};

describe("overlay input routing", () => {
  const overlayFor = (view: ViewComponent) => {
    const components: OverlayComponent[] = [];
    const state: HostState = {
      ctx: {
        mode: "tui",
        cwd: "/repo",
        ui: {
          custom: async (factory: (...args: unknown[]) => OverlayComponent) => {
            components.push(
              factory(
                { terminal: { rows: 40 }, mode: "fullscreen", requestRender: () => {} },
                {},
                { matches: (data: string, id: string) => ARROW_BINDINGS[data] === id },
                () => {},
              ),
            );
          },
        },
      } as unknown as ExtensionContext,
    };

    void createUi(
      state,
      { write: () => {} },
      {},
      createEditorHooks(() => undefined),
    ).openOverlay(() => view);

    return components[0] as OverlayComponent;
  };

  const mouse = (type: string, extra: object = {}) => ({
    type,
    button: "left",
    x: 3,
    y: 7,
    screenX: 3,
    screenY: 7,
    width: 80,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  });

  it("names keys through pi's keybindings before the view sees them", () => {
    const keys: KeyPress[] = [];
    const component = overlayFor({
      render: () => [],
      handleKey: (key) => {
        keys.push(key);
      },
    });

    [`${ESC}[A`, `${ESC}[B`, `${ESC}[D`, "x"].forEach((data) => {
      component.handleInput(data);
    });

    expect(keys.map((key) => [key.name, key.char])).toEqual([
      ["up", undefined],
      ["down", undefined],
      ["other", undefined],
      ["other", "x"],
    ]);
  });

  it("forwards a left click to the view and reports whether it used it", () => {
    const clicks: [number, number][] = [];
    let used = true;
    const component = overlayFor({
      render: () => [],
      handleKey: () => {},
      handleClick: (x, y) => {
        clicks.push([x, y]);
        return used;
      },
    });

    expect(component.handleMouse(mouse("click", { clickCount: 1 }))).toEqual({ handled: true });

    used = false;

    expect(component.handleMouse(mouse("click", { clickCount: 1 }))).toBeUndefined();
    expect(component.handleMouse(mouse("click", { button: "right", clickCount: 1 }))).toBeUndefined();
    expect(component.handleMouse(mouse("press"))).toBeUndefined();
    expect(clicks).toEqual([
      [3, 7],
      [3, 7],
    ]);
  });

  it("still scrolls with the wheel", () => {
    const wheels: number[] = [];
    const component = overlayFor({
      render: () => [],
      handleKey: () => {},
      handleWheel: (lines) => {
        wheels.push(lines);
      },
    });

    expect(component.handleMouse(mouse("wheel", { button: "none", wheelDelta: 3 }))).toEqual({
      handled: true,
    });
    expect(wheels).toEqual([3]);
  });
});
