import type { ThemeToken } from "./theme.ts";
import type { RowLines } from "./tools.ts";
import type {
  EditorFrame,
  EditorKeyHandler,
  FooterRender,
  FormFactory,
  OverlayFactory,
  WidgetHandle,
} from "./view.ts";

export type NotifyChannel = "auto" | "bell";

export type NoticeUi = {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setNotice(key: string, text: string | undefined): void;
  confirm(title: string, message: string): Promise<boolean>;
  terminalNotify(message: string, channel: NotifyChannel): void;
};

export type ClipboardUi = {
  copyText(text: string): Promise<void>;
};

export type OverlayUi = {
  openOverlay(factory: OverlayFactory): Promise<void>;
  showForm<T>(factory: FormFactory<T>, options?: { signal?: AbortSignal }): Promise<T | undefined>;
};

export type WidgetUi = {
  setWidget(key: string, render: RowLines | undefined): WidgetHandle;
  setFooter(render: FooterRender | undefined): WidgetHandle;
  setWorkingMessage(text: string | undefined): void;
  setWorkingVisible(visible: boolean): void;
  setHiddenThinkingLabel(label: string | undefined, hint?: string): void;
};

export type EditorUi = {
  onEditorSubmit(rewrite: (text: string) => string | undefined): () => void;
  mapCommandCompletion(map: (command: string) => string | undefined): void;
  submitEditor(text: string): Promise<boolean>;
  getEditorText(): string;
  setEditorText(text: string): void;
  setEditorFrame(frame: EditorFrame | undefined): void;
  onEmptyEditorLeft(handler: () => void): () => void;
  onEmptyEditorDown(handler: () => void): () => void;
  onEmptyEditorEscape(handler: () => boolean): () => void;
  captureEditorKeys(handler: EditorKeyHandler): () => void;
};

type KeysUi = {
  keyText(binding: string): string;
  onKeyPress(listener: () => void): () => void;
};

export type HostUi = NoticeUi &
  ClipboardUi &
  OverlayUi &
  WidgetUi &
  EditorUi &
  KeysUi & {
    style(token: ThemeToken, text: string): string;
  };
