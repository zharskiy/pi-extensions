export type Osc52Segment = { kind: "pass"; bytes: Buffer } | { kind: "copy"; text: Buffer; sequence: Buffer };

export const OSC52_MAX_BYTES = 131_072;

export const OSC_OPENER_MAX_BYTES = 16;

const OSC_NUMBER_MAX = 65_535;

const ESC = 0x1b;

const BEL = 0x07;

const CAN = 0x18;

const SUB = 0x1a;

const DEL = 0x7f;

const C1_OSC = 0x9d;

const UTF8_C1_LEAD = 0xc2;

const BACKSLASH = 0x5c;

const BRACKET = 0x5d;

const SEMICOLON = 0x3b;

const DIGIT_ZERO = 0x30;

const DIGIT_NINE = 0x39;

const CLIPBOARD = 52;

const WRITE = /^([cpqs0-7]*);((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;

type State = "text" | "escape" | "lead" | "number" | "body" | "bodyEscape";

const isIgnorable = (byte: number) =>
  (byte < 0x20 && byte !== BEL && byte !== CAN && byte !== SUB && byte !== ESC) || byte === DEL;

const isExecuted = (byte: number) => byte === BEL || isIgnorable(byte);

const isControl = (byte: number) => byte < 0x20 || byte === DEL;

const isDigit = (byte: number) => byte >= DIGIT_ZERO && byte <= DIGIT_NINE;

const startsPrefix = (byte: number) => byte === ESC || byte === UTF8_C1_LEAD;

const writeOf = (body: Buffer): Osc52Segment | undefined => {
  const match = WRITE.exec(body.toString("latin1"));

  if (match === null) {
    return undefined;
  }

  const [, selection, payload] = match;
  const sequence = Buffer.from(`\x1b]52;${selection};${payload}\x07`, "latin1");

  return { kind: "copy", text: Buffer.from(payload ?? "", "base64"), sequence };
};

export class Osc52Filter {
  private state: State = "text";

  private pending: number[] = [];

  private held: number[] = [];

  private number = 0;

  private digits = 0;

  private body: number[] = [];

  private size = 0;

  private invalid = false;

  private chunk: Buffer = Buffer.alloc(0);

  private passFrom = 0;

  private parts: Buffer[] = [];

  private segments: Osc52Segment[] = [];

  private readonly handlers: Record<State, (byte: number, index: number) => void> = {
    text: (byte, index) => this.text(byte, index),
    escape: (byte, index) => this.escape(byte, index),
    lead: (byte, index) => this.lead(byte, index),
    number: (byte, index) => this.numberByte(byte, index),
    body: (byte, index) => this.bodyByte(byte, index),
    bodyEscape: (byte, index) => this.bodyEscape(byte, index),
  };

  push(chunk: Buffer): Osc52Segment[] {
    this.chunk = chunk;
    this.passFrom = 0;

    chunk.forEach((byte, index) => {
      this.handlers[this.state](byte, index);
    });

    if (this.state === "text") {
      this.passRange(chunk.length);
    }

    return this.collected();
  }

  flush(): Osc52Segment[] {
    this.dropHeld();

    this.state = "text";
    this.body = [];

    return this.collected();
  }

  private collected() {
    this.closePass();

    const segments = this.segments;

    this.segments = [];
    this.chunk = Buffer.alloc(0);

    return segments;
  }

  private text(byte: number, index: number) {
    if (!startsPrefix(byte)) {
      return;
    }

    this.passRange(index);

    this.open(byte);
  }

  private open(byte: number) {
    this.held = [byte];
    this.state = byte === ESC ? "escape" : "lead";
  }

  private interrupt(byte: number) {
    this.pending.push(...this.held);

    if (this.pending.length > OSC_OPENER_MAX_BYTES) {
      this.dropHeld();
    }

    this.open(byte);
  }

  private escape(byte: number, index: number) {
    if (byte === BRACKET) {
      this.held.push(byte);

      this.number = 0;
      this.digits = 0;
      this.state = "number";

      return;
    }

    if (isExecuted(byte)) {
      this.holdExecuted(byte, index);

      return;
    }

    if (startsPrefix(byte)) {
      this.interrupt(byte);

      return;
    }

    if (byte === CAN || byte === SUB) {
      this.held.push(byte);

      this.passHeld();

      this.resume(index + 1);

      return;
    }

    this.passHeld();

    this.resume(index);
  }

  private lead(byte: number, index: number) {
    if (byte === C1_OSC) {
      this.held.push(byte);

      this.number = 0;
      this.digits = 0;
      this.state = "number";

      return;
    }

    if (isExecuted(byte)) {
      this.holdExecuted(byte, index);

      return;
    }

    if (startsPrefix(byte)) {
      this.interrupt(byte);

      return;
    }

    this.passHeld();

    this.resume(index);
  }

  private holdExecuted(byte: number, index: number) {
    this.held.push(byte);

    if (this.held.length > OSC_OPENER_MAX_BYTES) {
      this.dropHeld();

      this.resume(index + 1);
    }
  }

  private numberByte(byte: number, index: number) {
    if (isDigit(byte) || isIgnorable(byte)) {
      this.held.push(byte);

      if (isDigit(byte)) {
        this.digits += 1;
        this.number = Math.min(this.number * 10 + byte - DIGIT_ZERO, OSC_NUMBER_MAX + 1);
      }

      if (this.held.length > OSC_OPENER_MAX_BYTES) {
        this.openBody(true);
      }

      return;
    }

    const consumed = this.digits > 0 && (this.number === CLIPBOARD || this.number > OSC_NUMBER_MAX);

    if (consumed) {
      this.openBody(byte !== SEMICOLON || this.number !== CLIPBOARD);

      if (byte !== SEMICOLON) {
        this.bodyByte(byte, index);
      }

      return;
    }

    if (startsPrefix(byte)) {
      this.interrupt(byte);

      return;
    }

    this.passHeld();

    this.resume(index);
  }

  private openBody(invalid: boolean) {
    this.held = [];

    this.dropHeld();

    this.body = [];
    this.size = 0;
    this.invalid = invalid;
    this.state = "body";
  }

  private bodyByte(byte: number, index: number) {
    if (byte === BEL) {
      this.complete(index + 1);

      return;
    }

    if (byte === ESC) {
      this.state = "bodyEscape";

      return;
    }

    if (byte === CAN || byte === SUB) {
      this.body = [];

      this.resume(index + 1);

      return;
    }

    this.size += 1;
    this.invalid = this.invalid || isControl(byte) || this.size > OSC52_MAX_BYTES;

    if (!this.invalid) {
      this.body.push(byte);
    }
  }

  private bodyEscape(byte: number, index: number) {
    if (byte === BACKSLASH) {
      this.complete(index + 1);

      return;
    }

    this.body = [];

    this.open(ESC);

    this.escape(byte, index);
  }

  private complete(next: number) {
    const copy = this.invalid ? undefined : writeOf(Buffer.from(this.body));

    if (copy !== undefined) {
      this.closePass();

      this.segments.push(copy);
    }

    this.body = [];

    this.resume(next);
  }

  private resume(next: number) {
    this.state = "text";
    this.passFrom = next;
  }

  private passRange(to: number) {
    if (to > this.passFrom) {
      this.parts.push(Buffer.from(this.chunk.subarray(this.passFrom, to)));
    }

    this.passFrom = to;
  }

  private passHeld() {
    const bytes = [...this.pending, ...this.held];

    if (bytes.length > 0) {
      this.parts.push(Buffer.from(bytes));
    }

    this.pending = [];
    this.held = [];
  }

  private dropHeld() {
    const controls = [...this.pending, ...this.held].filter(isExecuted);

    if (controls.length > 0) {
      this.parts.push(Buffer.from(controls));
    }

    this.pending = [];
    this.held = [];
  }

  private closePass() {
    if (this.parts.length > 0) {
      this.segments.push({ kind: "pass", bytes: Buffer.concat(this.parts) });
    }

    this.parts = [];
  }
}
