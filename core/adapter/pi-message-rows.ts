import { AssistantMessageComponent, type Theme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Markdown,
  MouseRegion,
  Spacer,
  sliceByColumn,
  stripTerminalSequences,
  Text,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { GLYPHS } from "../manager/row.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 133 prompt marks are ESC and BEL sequences
export const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

const GLYPH_COLUMNS = 2;

type Render = (this: Container, width: number) => string[];

type MouseHandler = (
  this: Container,
  event: TuiMouseEvent,
) => ReturnType<NonNullable<Component["handleMouse"]>>;

type Prototype = { render: Render; handleMouse?: MouseHandler };

type Installed = {
  user: Render;
  assistant: Render;
  assistantMouse?: PropertyDescriptor;
};

type ThemeSource = () => Theme | undefined;

type MessageRowsRecord = {
  theme?: ThemeSource;
  installed?: Installed;
  owners?: Map<object, ThemeSource>;
  label?: string;
  labelOwner?: object;
};

const RECORD = Symbol.for("pi-extensions.message-rows");

const record = (): MessageRowsRecord => {
  const store = globalThis as { [RECORD]?: MessageRowsRecord };

  store[RECORD] ??= {};

  return store[RECORD];
};

const userPrototype = () => UserMessageComponent?.prototype as unknown as Prototype | undefined;

const assistantPrototype = () => AssistantMessageComponent?.prototype as unknown as Prototype | undefined;

const rowWidths = new WeakMap<object, number>();

const padOf = (component: object) => {
  const pad = (component as { outputPad?: unknown }).outputPad;

  return typeof pad === "number" ? pad : 1;
};

const markOf = (line: string | undefined) => line?.match(OSC133_ZONE_PREFIX)?.[0] ?? "";

const unmarked = (lines: string[]) => lines.map((line) => line.replace(OSC133_ZONE_PREFIX, ""));

const remarked = (lines: string[], first: string, last: string) =>
  lines.map((line, index) => `${index === lines.length - 1 ? last : ""}${index === 0 ? first : ""}${line}`);

const insertAt = (line: string, column: number, inserted: string, width: number) =>
  `${sliceByColumn(line, 0, column)}${inserted}${sliceByColumn(line, column, width)}`;

const isBlank = (line: string) => stripTerminalSequences(line).trim() === "";

const userRows = (component: Container, width: number, original: Render, theme: Theme) => {
  if (component.children.length !== 1 || !(component.children[0] instanceof Markdown)) {
    return undefined;
  }

  const raw = original.call(component, width - GLYPH_COLUMNS);
  const first = markOf(raw[0]);
  const last = raw.length > 1 ? markOf(raw.at(-1)) : "";
  const lines = unmarked(raw);
  const start = isBlank(lines[0] ?? "") ? 1 : 0;
  const end = lines.length > start && isBlank(lines.at(-1) ?? "") ? lines.length - 1 : lines.length;
  const pad = padOf(component);
  const prompt = theme.bg("userMessageBg", `${theme.fg("muted", GLYPHS.chevron)} `);
  const indent = theme.bg("userMessageBg", "  ");
  const rows = lines
    .slice(start, end)
    .map((line, index) => insertAt(line, pad, index === 0 ? prompt : indent, width));

  return remarked(rows, first, last);
};

const glyphFor = (child: Component, line: string, pad: number, theme: Theme) => {
  if (child instanceof Markdown) {
    return `${theme.fg("text", GLYPHS.bullet)} `;
  }

  if (child instanceof Text) {
    return `${theme.fg("error", GLYPHS.bullet)} `;
  }

  if (!(child instanceof MouseRegion)) {
    return "  ";
  }

  const shown = stripTerminalSequences(sliceByColumn(line, pad, Number.MAX_SAFE_INTEGER)).trimStart();

  return shown.startsWith(GLYPHS.thinking) ? "" : `${theme.fg("dim", GLYPHS.thinking)} `;
};

const childRows = (child: Component, lines: string[], pad: number, width: number, theme: Theme) => {
  if (child instanceof Spacer) {
    return lines;
  }

  const glyph = glyphFor(child, lines[0] ?? "", pad, theme);
  const indent = glyph === "" ? "" : "  ";

  return lines.map((line, index) => insertAt(line, pad, index === 0 ? glyph : indent, width));
};

const chunks = (lines: string[], heights: number[]) =>
  heights.reduce<{ start: number; parts: string[][] }>(
    (acc, height) => ({
      start: acc.start + height,
      parts: [...acc.parts, lines.slice(acc.start, acc.start + height)],
    }),
    { start: 0, parts: [] },
  ).parts;

const assistantRows = (component: Container, width: number, original: Render, theme: Theme) => {
  const content = component.children[0];

  if (component.children.length !== 1 || !(content instanceof Container)) {
    return undefined;
  }

  const raw = original.call(component, width - GLYPH_COLUMNS);
  const heights = content.children.map((child) => child.render(width - GLYPH_COLUMNS).length);

  if (heights.reduce((sum, height) => sum + height, 0) !== raw.length) {
    return undefined;
  }

  const first = markOf(raw[0]);
  const last = raw.length > 1 ? markOf(raw.at(-1)) : "";
  const lines = unmarked(raw);
  const pad = padOf(component);
  const rows = chunks(lines, heights).flatMap((chunk, index) =>
    childRows(content.children[index] as Component, chunk, pad, width, theme),
  );

  return remarked(rows, first, last);
};

const canInstall = () => {
  const user = userPrototype();
  const assistant = assistantPrototype();

  return (
    typeof user?.render === "function" &&
    typeof assistant?.render === "function" &&
    typeof Container?.prototype?.handleMouse === "function" &&
    typeof Markdown === "function" &&
    typeof MouseRegion === "function"
  );
};

const attempt = (render: () => string[] | undefined) => {
  try {
    return render();
  } catch {
    return undefined;
  }
};

const styled = (
  original: Render,
  rows: (component: Container, width: number, original: Render, theme: Theme) => string[] | undefined,
): Render =>
  function (this: Container, width: number) {
    const theme = record().theme?.();

    if (!theme || width <= GLYPH_COLUMNS + 1) {
      rowWidths.delete(this);
      return original.call(this, width);
    }

    const lines = attempt(() => rows(this, width, original, theme));

    if (!lines) {
      rowWidths.delete(this);
      return original.call(this, width);
    }

    rowWidths.set(this, width - GLYPH_COLUMNS);

    return lines;
  };

const mouseThrough = (original: MouseHandler): MouseHandler =>
  function (this: Container, event: TuiMouseEvent) {
    const shifted = rowWidths.get(this) === event.width - GLYPH_COLUMNS;

    return original.call(this, shifted ? { ...event, width: event.width - GLYPH_COLUMNS } : event);
  };

const ownMouse = (prototype: Prototype) => Object.getOwnPropertyDescriptor(prototype, "handleMouse");

const restoreMouse = (prototype: Prototype, descriptor: PropertyDescriptor | undefined) => {
  if (descriptor) {
    Object.defineProperty(prototype, "handleMouse", descriptor);
    return;
  }

  delete prototype.handleMouse;
};

const patchMouse = (prototype: Prototype) => {
  const original = (prototype.handleMouse ?? Container.prototype.handleMouse) as MouseHandler;

  Object.defineProperty(prototype, "handleMouse", {
    value: mouseThrough(original),
    configurable: true,
    writable: true,
  });
};

export const installMessageRows = (theme: () => Theme | undefined, owner: object = {}) => {
  if (!canInstall()) {
    return false;
  }

  const shared = record();
  const user = userPrototype() as Prototype;
  const assistant = assistantPrototype() as Prototype;

  shared.owners ??= new Map();
  shared.owners.delete(owner);
  shared.owners.set(owner, theme);
  shared.theme = theme;

  if (shared.installed) {
    return true;
  }

  shared.installed = {
    user: user.render,
    assistant: assistant.render,
    assistantMouse: ownMouse(assistant),
  };

  user.render = styled(shared.installed.user, userRows);
  assistant.render = styled(shared.installed.assistant, assistantRows);
  patchMouse(assistant);

  return true;
};

export const uninstallMessageRows = (owner?: object) => {
  const shared = record();
  const installed = shared.installed;

  if (!installed || (owner && !shared.owners?.has(owner))) {
    return;
  }

  if (owner) {
    shared.owners?.delete(owner);
  }

  const rest = owner ? Array.from(shared.owners?.values() ?? []) : [];

  if (rest.length > 0) {
    shared.theme = rest.at(-1);
    return;
  }

  const user = userPrototype() as Prototype;
  const assistant = assistantPrototype() as Prototype;

  user.render = installed.user;
  assistant.render = installed.assistant;
  restoreMouse(assistant, installed.assistantMouse);
  shared.installed = undefined;
  shared.theme = undefined;
  shared.owners = undefined;
};

export const hiddenThinkingLabel = () => record().label;

export const storeHiddenThinkingLabel = (label: string | undefined, owner: object) => {
  const shared = record();

  shared.label = label;
  shared.labelOwner = label === undefined ? undefined : owner;
};

export const releaseHiddenThinkingLabel = (owner: object) => {
  const shared = record();

  if (shared.labelOwner !== owner) {
    return;
  }

  shared.label = undefined;
  shared.labelOwner = undefined;
};
