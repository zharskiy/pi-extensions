import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createInputPane, createUi, type HostState, notificationSequence } from "../../adapter/pi-ui.ts";

const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);

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

  return { ui: createUi(state, { write: () => {} }, {}), inputs, removed };
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
  const ui = createUi(state, { write: (data: string) => writes.push(data) }, env);

  return { ui, writes, state };
};

describe("terminalNotify", () => {
  it("writes the bell and one OSC 9 notification in tui mode", () => {
    const { ui, writes } = captured("tui", { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty" });

    ui.terminalNotify("pi-subagents: scout done", "Found three files");

    expect(writes).toEqual([`${BEL}${ESC}]9;pi-subagents: scout done: Found three files${BEL}`]);
  });

  it("writes OSC 777 instead of OSC 9 for rxvt terminals", () => {
    const { ui, writes } = captured("tui", { TERM: "rxvt-unicode-256color" });

    ui.terminalNotify("pi-subagents: scout done", "Found three files");

    expect(writes).toEqual([`${BEL}${ESC}]777;notify;pi-subagents: scout done;Found three files${BEL}`]);
  });

  it("writes nothing in rpc, print or json mode, or once the session is stale", () => {
    const silent = ["rpc", "print", "json"].map((mode) => {
      const { ui, writes } = captured(mode);

      ui.terminalNotify("title", "body");

      return writes.length;
    });

    const stale = captured("tui");

    stale.state.ctx = undefined;
    stale.ui.terminalNotify("title", "body");

    expect(silent).toEqual([0, 0, 0]);
    expect(stale.writes).toEqual([]);
  });

  it("strips control characters and keeps the title free of separators", () => {
    const title = `a;b${ESC}]0;x`;
    const body = `line one${BEL}\nline two`;

    expect(notificationSequence(title, body, {})).toBe(`${BEL}${ESC}]9;a,b ]0,x: line one line two${BEL}`);
    expect(notificationSequence(title, body, { TERM_PROGRAM: "urxvt" })).toBe(
      `${BEL}${ESC}]777;notify;a,b ]0,x;line one line two${BEL}`,
    );
  });
});
