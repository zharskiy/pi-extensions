export type KeySegment = { kind: "keys"; bytes: Buffer } | { kind: "ctrlV"; bytes: Buffer };

type State = "ground" | "escape" | "escapes" | "csi" | "sgr" | "x10" | "ss3" | "osc" | "string";

type Candidate = "prefix" | "match" | "none";

const ESC = 0x1b;

const BEL = 0x07;

const CTRL_V = 0x16;

const PASTE_START = "\x1b[200~";

const PASTE_END = "\x1b[201~";

const CANDIDATE_MAX_BYTES = 40;

const FIELD_MAX_DIGITS = 7;

const SGR_MAX_BYTES = 64;

const STRING_HOLD_MAX_BYTES = 1024;

const REPLY_HEADER_MAX_BYTES = 64;

const REPLY_HEADER = /^(?:\](?:1[01];|4;\d{1,3};|7501;\?)|P>\||_G(?:[a-z]=\d+,)*[a-z]=\d+;)/;

const AFTER_ESCAPES = ["[", "]", "O", "P", "_"];

const X10_BYTES = 3;

const LAYOUT_KEY_MIN = 128;

const CTRL_V_CODE = "118";

const CTRL_MODIFIERS = ["5", "69", "133", "197"];

const PRESS_EVENTS = ["1", "2"];

const MODIFY_OTHER_KEYS = "27;5;118~";

const KITTY_FIELDS = /^(\d*)(?:(:)(\d*)(?:(:)(\d*))?)?(?:(;)(\d*)(?:(:)(\d*))?)?$/;

const SGR_MOUSE = /^<\d+;\d+;\d+[Mm]$/;

const STRING_OPENERS: Record<string, State> = { "]": "osc", P: "string", _: "string" };

const isFinal = (byte: number) => byte >= 0x40 && byte <= 0x7e;

const isLayoutKey = (code: string) => /^[1-9]\d*$/.test(code) && Number(code) >= LAYOUT_KEY_MIN;

const keyFits = (code: string, base: string | undefined, baseOpen: boolean, baseCanFollow: boolean) => {
  if (code === CTRL_V_CODE) {
    return base === undefined || baseOpen || base !== "";
  }

  if (!isLayoutKey(code)) {
    return false;
  }

  if (base === undefined) {
    return baseCanFollow;
  }

  return baseOpen ? CTRL_V_CODE.startsWith(base) : base === CTRL_V_CODE;
};

const modifierFits = (modifier: string | undefined, open: boolean, closed: boolean) => {
  if (modifier === undefined) {
    return !closed;
  }

  return open
    ? CTRL_MODIFIERS.some((value) => value.startsWith(modifier))
    : CTRL_MODIFIERS.includes(modifier);
};

const eventFits = (event: string | undefined, open: boolean) => {
  if (event === undefined) {
    return true;
  }

  return open ? event === "" || PRESS_EVENTS.includes(event) : PRESS_EVENTS.includes(event);
};

const kittyFits = (body: string, closed: boolean) => {
  const match = KITTY_FIELDS.exec(body);

  if (match === null) {
    return false;
  }

  const [, code = "", shiftedMark, shifted = "", baseMark, baseDigits = "", modifierMark] = match;
  const [modifierDigits = "", eventMark, eventDigits = ""] = match.slice(7);

  if (
    [code, shifted, baseDigits, modifierDigits, eventDigits].some((field) => field.length > FIELD_MAX_DIGITS)
  ) {
    return false;
  }

  if (!closed && shiftedMark === undefined && modifierMark === undefined) {
    return code === "" || !code.startsWith("0");
  }

  const base = baseMark === undefined ? undefined : baseDigits;
  const modifier = modifierMark === undefined ? undefined : modifierDigits;
  const event = eventMark === undefined ? undefined : eventDigits;
  const beforeModifier = !closed && modifier === undefined;

  return (
    keyFits(code, base, beforeModifier, beforeModifier) &&
    modifierFits(modifier, !closed && event === undefined, closed) &&
    eventFits(event, !closed)
  );
};

export const ctrlVCandidate = (payload: string): Candidate => {
  if (payload.length === 0 || payload.length > CANDIDATE_MAX_BYTES) {
    return payload.length === 0 ? "prefix" : "none";
  }

  if (!isFinal(payload.charCodeAt(payload.length - 1))) {
    return kittyFits(payload, false) || MODIFY_OTHER_KEYS.startsWith(payload) ? "prefix" : "none";
  }

  const kitty = payload.endsWith("u") && kittyFits(payload.slice(0, -1), true);

  return kitty || payload === MODIFY_OTHER_KEYS ? "match" : "none";
};

export class CtrlVScanner {
  private state: State = "ground";

  private payload = "";

  private csiBytes = 0;

  private remaining = 0;

  private escaped = false;

  private candidate = false;

  private holdingString = false;

  private pasting = false;

  private tail = "";

  private held: number[] = [];

  private keys: number[] = [];

  private segments: KeySegment[] = [];

  push(chunk: Buffer): KeySegment[] {
    chunk.forEach((byte) => {
      this.step(byte);
    });

    this.settle();

    return this.take();
  }

  pasted(): KeySegment[] {
    this.release();

    this.reset();

    this.pasting = false;
    this.tail = "";

    return this.take();
  }

  idle(): KeySegment[] {
    if (this.holdingString) {
      this.rescan();
    } else if (this.held.length > 0) {
      this.release();
    } else {
      this.reset();
    }

    return this.take();
  }

  flush(): KeySegment[] {
    this.release();

    return this.take();
  }

  waiting() {
    return this.held.length > 0 || this.state !== "ground";
  }

  private settle() {
    const bare = this.held.length === 1 || (this.held.length === 2 && this.state === "csi");

    if (bare && !this.holdingString) {
      this.release();

      this.reset();
    }
  }

  private rescan() {
    const tail = this.held.slice(2);

    this.keys.push(...this.held.slice(0, 2));

    this.held = [];
    this.holdingString = false;

    this.reset();

    tail.forEach((byte) => {
      this.advance(byte);
    });

    this.settle();
  }

  private step(byte: number) {
    if (this.pasting) {
      this.keys.push(byte);
    } else {
      this.advance(byte);
    }

    this.track(byte);
  }

  private track(byte: number) {
    this.tail = `${this.tail}${String.fromCharCode(byte)}`.slice(-PASTE_START.length);

    if (this.tail === (this.pasting ? PASTE_END : PASTE_START)) {
      this.release();

      this.reset();

      this.pasting = !this.pasting;
    }
  }

  private advance(byte: number) {
    const handlers: Record<State, (value: number) => void> = {
      ground: (value) => this.inGround(value),
      escape: (value) => this.inEscape(value),
      escapes: (value) => this.inEscapes(value),
      csi: (value) => this.inCsi(value),
      sgr: (value) => this.inSgr(value),
      x10: (value) => this.inX10(value),
      ss3: (value) => this.forwardThen(value, "ground"),
      osc: (value) => this.inString(value),
      string: (value) => this.inString(value),
    };

    handlers[this.state](byte);
  }

  private inGround(byte: number) {
    if (byte === CTRL_V) {
      this.matched([byte]);

      return;
    }

    if (byte === ESC) {
      this.state = "escape";
      this.candidate = true;
      this.held = [byte];

      return;
    }

    this.keys.push(byte);
  }

  private inEscape(byte: number) {
    const opener = String.fromCharCode(byte);

    if (opener === "[") {
      this.state = "csi";
      this.payload = "";
      this.csiBytes = 0;

      this.keep(byte);

      return;
    }

    if (byte === ESC) {
      this.release();

      this.state = "escapes";
      this.candidate = true;
      this.held = [byte];

      return;
    }

    const string = STRING_OPENERS[opener];

    if (string !== undefined) {
      this.held.push(byte);

      this.state = string;
      this.candidate = false;
      this.holdingString = true;
      this.escaped = false;

      return;
    }

    this.forwardThen(byte, opener === "O" ? "ss3" : "ground");
  }

  private inEscapes(byte: number) {
    if (AFTER_ESCAPES.includes(String.fromCharCode(byte))) {
      this.inEscape(byte);

      return;
    }

    this.release();

    this.state = "ground";

    this.inGround(byte);
  }

  private inCsi(byte: number) {
    const character = String.fromCharCode(byte);

    this.csiBytes += 1;

    if (this.csiBytes === 1 && (character === "M" || character === "<")) {
      this.payload = character;
      this.remaining = X10_BYTES;

      this.forwardThen(byte, character === "M" ? "x10" : "sgr");

      return;
    }

    if (this.candidate) {
      this.payload = `${this.payload}${character}`;

      this.judge(byte, ctrlVCandidate(this.payload));
    } else {
      this.keys.push(byte);
    }

    if (isFinal(byte)) {
      this.state = "ground";
    }
  }

  private inSgr(byte: number) {
    this.keys.push(byte);

    if (this.payload.length >= SGR_MAX_BYTES) {
      return;
    }

    this.payload = `${this.payload}${String.fromCharCode(byte)}`;

    if (SGR_MOUSE.test(this.payload)) {
      this.reset();
    }
  }

  private inX10(byte: number) {
    this.keys.push(byte);

    this.remaining -= 1;

    if (this.remaining === 0) {
      this.reset();
    }
  }

  private inString(byte: number) {
    if (this.holdingString) {
      this.held.push(byte);
    } else {
      this.keys.push(byte);
    }

    if ((this.escaped && byte === 0x5c) || (this.state === "osc" && byte === BEL)) {
      this.release();

      this.reset();

      return;
    }

    this.escaped = byte === ESC;

    if (this.holdingString && (this.held.length > STRING_HOLD_MAX_BYTES || this.replyHeader())) {
      this.release();
    }
  }

  private replyHeader() {
    if (this.held.length > REPLY_HEADER_MAX_BYTES) {
      return false;
    }

    return REPLY_HEADER.test(Buffer.from(this.held.slice(1)).toString("latin1"));
  }

  private judge(byte: number, candidate: Candidate) {
    if (candidate === "match") {
      this.matched([...this.held, byte]);

      this.held = [];
      this.candidate = false;

      return;
    }

    if (candidate === "prefix") {
      this.held.push(byte);

      return;
    }

    this.held.push(byte);

    this.release();
  }

  private keep(byte: number) {
    if (this.candidate) {
      this.held.push(byte);

      return;
    }

    this.keys.push(byte);
  }

  private forwardThen(byte: number, next: State) {
    this.keep(byte);

    this.release();

    this.state = next;
  }

  private matched(bytes: number[]) {
    this.flushKeys();

    this.segments.push({ kind: "ctrlV", bytes: Buffer.from(bytes) });
  }

  private release() {
    this.keys.push(...this.held);

    this.held = [];
    this.candidate = false;
    this.holdingString = false;
  }

  private reset() {
    this.state = "ground";
    this.payload = "";
    this.csiBytes = 0;
    this.remaining = 0;
    this.escaped = false;
  }

  private flushKeys() {
    if (this.keys.length > 0) {
      this.segments.push({ kind: "keys", bytes: Buffer.from(this.keys) });
    }

    this.keys = [];
  }

  private take() {
    this.flushKeys();

    const segments = this.segments;

    this.segments = [];

    return segments;
  }
}
