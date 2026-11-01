import type { KeyPress } from "./keys.ts";
import type { ThemeLike } from "./theme.ts";

export type ViewComponent = {
  render(width: number): string[];
  handleKey(key: KeyPress): void;
  handleWheel?(lines: number): void;
  handleClick?(x: number, y: number): boolean;
  dispose?(): void;
};

export type TranscriptItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; raw: unknown }
  | { kind: "tool"; toolCallId: string; raw: unknown }
  | { kind: "custom"; raw: unknown }
  | { kind: "entry"; customType: string; data: unknown }
  | { kind: "summary"; raw: unknown }
  | { kind: "bash"; raw: unknown }
  | { kind: "rule"; label: string };

export type TranscriptPane = {
  sync(items: TranscriptItem[]): void;
  setToolsExpanded(expanded: boolean): void;
  render(width: number): string[];
  click(line: number, column: number, width: number): boolean;
};

export type ScrollPane = {
  window(lines: string[], height: number): string[];
  scrollBy(lines: number): void;
  scrollTo(top: number, options?: { disableFollow?: boolean }): void;
  scrollToStart(): void;
  scrollToEnd(): void;
  state(): { top: number; height: number; total: number; following: boolean };
};

export type OverlayApi = {
  theme: ThemeLike;
  rows(): number;
  close(): void;
  requestRender(): void;
  toolsKey: string;
  createTranscript(): TranscriptPane;
  createScroll(): ScrollPane;
};

export type OverlayFactory = (api: OverlayApi) => ViewComponent;

export type TextInput = {
  render(width: number): string[];
  handleKey(key: KeyPress): void;
  setText(text: string): void;
  onSubmit(handler: (text: string) => void): void;
};

export type FormApi<T> = {
  theme: ThemeLike;
  requestRender(): void;
  done(result: T): void;
  createTextInput(): TextInput;
};

export type FormFactory<T> = (api: FormApi<T>) => ViewComponent;

export type WidgetHandle = { refresh(): void };

export type EditorLayout = { bottom: number; scrolled: boolean };

export type EditorFrame = {
  chrome: number;
  minWidth: number;
  decorate(
    lines: string[],
    layout: EditorLayout,
    paint: (text: string) => string,
    theme: ThemeLike,
  ): string[];
};

export type EditorKeyHandler = (key: KeyPress) => "consumed" | "release";

export type FooterData = { branch: string | null; statuses: ReadonlyMap<string, string> };

export type FooterRender = (width: number, theme: ThemeLike, data: FooterData) => string[];

export type EntryRender = (
  data: unknown,
  width: number,
  expanded: boolean,
  theme: ThemeLike,
  pad: number,
) => string[];

export type EntryOptions = { flush?: boolean; previousSession?: boolean };

export type MessageRender = (
  message: { text: string; details?: unknown },
  width: number,
  expanded: boolean,
  theme: ThemeLike,
) => string[];
