import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { KeyPress } from "../types/keys.ts";
import { keyPress } from "./key-events.ts";
import { fitLines } from "./theme-bridge.ts";

type KeyView = { render(width: number): string[]; handleKey(key: KeyPress): void; dispose?(): void };

type MouseResult = { handled: true } | undefined;

export type CustomView = {
  view: KeyView;
  focus?: { get(): boolean; set(value: boolean): void };
  handleMouse?: (event: TuiMouseEvent) => MouseResult;
  dispose?: () => void;
};

type CustomOptions = Parameters<ExtensionContext["ui"]["custom"]>[1];

type CustomComponent = Component & { dispose(): void; handleMouse?: (event: TuiMouseEvent) => MouseResult };

export const showCustomView = <T>(
  ctx: ExtensionContext,
  build: (tui: TUI, theme: Theme, done: (result: T) => void) => CustomView,
  options?: CustomOptions,
) =>
  ctx.ui.custom<T>((tui, theme, keybindings: KeybindingsManager, done) => {
    const custom = build(tui, theme, done);
    const { view, focus, handleMouse } = custom;

    const component: CustomComponent = {
      render: (width: number) => fitLines(view.render(width), width),
      handleInput: (data: string) => {
        view.handleKey(keyPress(data, keybindings));
        tui.requestRender();
      },
      invalidate: () => {},
      dispose: () => {
        custom.dispose?.();
        view.dispose?.();
      },
    };

    if (handleMouse) {
      component.handleMouse = handleMouse;
    }

    if (focus) {
      Object.defineProperty(component, "focused", {
        get: focus.get,
        set: focus.set,
        enumerable: true,
        configurable: true,
      });
    }

    return component;
  }, options);
