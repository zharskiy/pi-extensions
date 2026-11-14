export const BACK: unique symbol = Symbol("back");

export type Reply<T> = T | typeof BACK;

export type CancelCause = "interrupt" | "end";

export class Cancelled extends Error {
  readonly cause: CancelCause;

  constructor(cause: CancelCause) {
    super(cause === "interrupt" ? "cancelled" : "input ended");
    this.name = "Cancelled";
    this.cause = cause;
  }
}

export type Key =
  | { kind: "text"; text: string }
  | { kind: "paste"; text: string }
  | { kind: "ctrl"; letter: string }
  | {
      kind:
        | "up"
        | "down"
        | "left"
        | "right"
        | "home"
        | "end"
        | "enter"
        | "escape"
        | "tab"
        | "backspace"
        | "delete"
        | "space"
        | "word-left-delete"
        | "resize";
    };

export interface UiInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(raw: boolean): unknown;
}

export interface UiOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  fd?: number;
}

export interface Timers {
  now(): number;
  every(ms: number, tick: () => void): () => void;
}

export interface TerminalSession {
  raw(on: boolean): void;
  cursor(visible: boolean): void;
  paste(on: boolean): void;
  restore(): void;
}

export interface Ui {
  input: UiInput;
  output: UiOutput;
  mode: "rich" | "plain";
  unicode: boolean;
  colour: boolean;
  columns(): number;
  rows(): number;
  onResize(listener: () => void): () => void;
  session: TerminalSession;
  escapeCodeTimeout?: number;
  timers: Timers;
}

export type Collapse = string | { title: string; text: string } | undefined;

export type Detail = string[] | ((width: number) => string[]);

export interface KeyWords {
  enter?: string;
  escape?: string | false;
  interrupt?: string | false;
}

export interface Choice<T> {
  value: T;
  label: string;
  tag?: string;
  action?: true;
}

export interface SelectSpec<T> extends KeyWords {
  title: string;
  detail?: Detail;
  choices: Choice<T>[];
  initial?: T;
  radio?: boolean;
  collapsed?: (value: T) => Collapse;
}

export interface MultiSpec<T> extends KeyWords {
  title: string;
  detail?: Detail;
  choices: Choice<T>[];
  checked: T[];
  onAction?: (value: T) => Promise<Choice<T> | undefined>;
  validate?: (values: T[]) => string | undefined;
  collapsed?: (values: T[]) => Collapse;
  plain?: { help: string[]; label: string };
}

export interface ConfirmSpec extends KeyWords {
  title: string;
  detail?: Detail;
  yes: string;
  no: string;
  initial: boolean;
  collapsed?: (value: boolean) => Collapse;
}

export interface TextSpec extends KeyWords {
  title: string;
  initial?: string;
  validate?: (value: string) => string | undefined;
  collapsed?: (value: string) => Collapse;
}

export interface PathSpec extends TextSpec {
  readdir: (dir: string) => string[];
  home: string;
}

export interface NumberSpec extends KeyWords {
  title: string;
  note?: string;
  initial: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  tooLow: string;
  tooHigh: string;
  warn?: (value: number) => string | undefined;
  collapsed?: (value: number) => Collapse;
}

export interface TaskSpec<T> {
  title: string;
  run: (update: (text: string) => void) => Promise<T>;
  interruptWarning: string;
}

export type NotePlace = "rail" | "start" | "step" | "end";

export interface Prompts {
  select<T>(spec: SelectSpec<T>): Promise<Reply<T>>;
  multiselect<T>(spec: MultiSpec<T>): Promise<Reply<T[]>>;
  confirm(spec: ConfirmSpec): Promise<Reply<boolean>>;
  text(spec: TextSpec): Promise<Reply<string>>;
  path(spec: PathSpec): Promise<Reply<string>>;
  number(spec: NumberSpec): Promise<Reply<number>>;
  task<T>(spec: TaskSpec<T>): Promise<T>;
  note(lines: string[], place?: NotePlace): void;
}
