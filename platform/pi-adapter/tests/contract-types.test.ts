import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  EntryHost,
  Host,
  LifecycleHost,
  MessagingHost,
  PromptHost,
  SessionHost,
  ToolHost,
} from "../types/host-capabilities.ts";
import type { EditorUi, HostUi, KeysUi, NoticeUi, OverlayUi, WidgetUi } from "../types/host-ui.ts";
import {
  type AppKey,
  type EditKey,
  isNavigationKey,
  type KeyName,
  type NavigationKey,
} from "../types/keys.ts";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "../types/model.ts";
import type {
  MessageToken,
  PaintToken,
  StatusToken,
  SyntaxToken,
  ThemeToken,
  ThinkingToken,
} from "../types/theme.ts";

type FormerThemeToken =
  | "accent"
  | "border"
  | "borderAccent"
  | "syntaxString"
  | "syntaxVariable"
  | "muted"
  | "dim"
  | "success"
  | "warning"
  | "error"
  | "text"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax"
  | "customMessageLabel"
  | "customMessageText";

type FormerKeyName =
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end"
  | "enter"
  | "escape"
  | "space"
  | "tab"
  | "backTab"
  | "backspace"
  | "toggleTools"
  | "other";

type FormerHostMember =
  | "ui"
  | "registerTool"
  | "registerCommand"
  | "setMainPrompt"
  | "setPromptSection"
  | "onSessionStart"
  | "onSessionShutdown"
  | "onIdle"
  | "onTurnEnd"
  | "onCompact"
  | "isIdle"
  | "sendHiddenMessage"
  | "sendMessage"
  | "dispatchCommand"
  | "publish"
  | "subscribe"
  | "appendEntry"
  | "registerEntryRenderer"
  | "registerToolRows"
  | "registerMessageRenderer"
  | "readEntries"
  | "sessionUsage"
  | "session"
  | "onAgentStart"
  | "onAssistantEnd"
  | "onPhase"
  | "onDialog"
  | "context"
  | "model"
  | "thinkingLevel"
  | "sessionName"
  | "contextFacts"
  | "lastRequestUsage"
  | "mainRequestUsage";

type FormerHostUiMember =
  | "notify"
  | "setStatus"
  | "setNotice"
  | "confirm"
  | "setWidget"
  | "openOverlay"
  | "showForm"
  | "style"
  | "terminalNotify"
  | "setWorkingMessage"
  | "setWorkingVisible"
  | "onEditorSubmit"
  | "mapCommandCompletion"
  | "submitEditor"
  | "setEditorFrame"
  | "onEmptyEditorLeft"
  | "onEmptyEditorDown"
  | "onEmptyEditorEscape"
  | "captureEditorKeys"
  | "setFooter"
  | "keyText"
  | "copyText"
  | "onKeyPress"
  | "setHiddenThinkingLabel";

describe("contract types", () => {
  it("compose back to the former member sets", () => {
    expectTypeOf<
      PaintToken | StatusToken | SyntaxToken | ThinkingToken | MessageToken
    >().toEqualTypeOf<FormerThemeToken>();
    expectTypeOf<ThemeToken>().toEqualTypeOf<FormerThemeToken>();
    expectTypeOf<NavigationKey | EditKey | AppKey | "other">().toEqualTypeOf<FormerKeyName>();
    expectTypeOf<KeyName>().toEqualTypeOf<FormerKeyName>();
    expectTypeOf<
      keyof (ToolHost & PromptHost & LifecycleHost & MessagingHost & EntryHost & SessionHost) | "ui"
    >().toEqualTypeOf<FormerHostMember>();
    expectTypeOf<keyof Host>().toEqualTypeOf<FormerHostMember>();
    expectTypeOf<
      keyof (NoticeUi & OverlayUi & WidgetUi & EditorUi & KeysUi) | "style"
    >().toEqualTypeOf<FormerHostUiMember>();
    expectTypeOf<keyof HostUi>().toEqualTypeOf<FormerHostUiMember>();
    expectTypeOf<ThinkingLevel>().toEqualTypeOf<
      "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    >();
    expectTypeOf(THINKING_LEVELS).toEqualTypeOf<
      readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    >();
  });

  it("recognises thinking levels and navigation keys", () => {
    const navigation: KeyName[] = ["up", "pageDown", "end"];
    const other: KeyName[] = ["enter", "tab", "toggleTools", "other"];

    expect(THINKING_LEVELS.map(isThinkingLevel)).toEqual(THINKING_LEVELS.map(() => true));
    expect(["", "Off", "ultra"].map(isThinkingLevel)).toEqual([false, false, false]);
    expect(navigation.map(isNavigationKey)).toEqual([true, true, true]);
    expect(other.map(isNavigationKey)).toEqual([false, false, false, false]);
  });
});
