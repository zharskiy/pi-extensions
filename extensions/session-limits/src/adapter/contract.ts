export type ThemeToken = "warning" | "error";

export type ContextSnapshot = { tokens: number | null; window: number };

export type SessionInfo = {
  id: string;
  file?: string;
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
};

export type NewSessionOptions = { parentSession?: string; seed: { customType: string; text: string } };

export type SessionControl = {
  newSession(options: NewSessionOptions): Promise<boolean>;
};

export type CommandSpec = {
  description: string;
  run(control: SessionControl): Promise<void> | void;
};

export type Host = {
  notify(message: string, level: "info" | "warning" | "error"): void;
  style(token: ThemeToken, text: string): string;
  setStatus(key: string, text: string | undefined): void;
  confirm(title: string, message: string): Promise<boolean>;
  registerCommand(name: string, spec: CommandSpec): void;
  onSessionStart(handler: (info: SessionInfo) => void): void;
  onTurnEnd(handler: (context: ContextSnapshot) => void): void;
  onIdle(handler: () => void): void;
  onShutdown(handler: () => void): void;
  onEvent(channel: string, handler: (data: unknown) => void): void;
  isIdle(): boolean;
  session(): SessionInfo | undefined;
  sendUserMessage(text: string): void;
  dispatchCommand(name: string): void;
};
