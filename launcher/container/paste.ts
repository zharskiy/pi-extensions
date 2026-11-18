export type InputSegment = { kind: "keys"; bytes: Buffer } | { kind: "paste"; body: Buffer };

export interface PathToken {
  start: number;
  end: number;
  path: string;
  quote: string;
}

export const PASTE_MAX_BYTES = 65_536;

const PASTE_START = Buffer.from("\x1b[200~");

const PASTE_END = Buffer.from("\x1b[201~");

export const IMAGE_HEADER_BYTES = 12;

const PATH_TOKEN = /(?<=^|\s)(?:'(\/[^']*)'|"(\/(?:[^"\\]|\\.)*)"|(\/(?:\\.|[^\s\\'"])+))(?=\s|$)/g;

const ESCAPED = /\\(.)/gs;

const IMAGE_SIGNATURES: Array<{ extension: string; matches: (header: Buffer) => boolean }> = [
  {
    extension: "png",
    matches: (header) =>
      header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { extension: "jpg", matches: (header) => header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  {
    extension: "gif",
    matches: (header) => ["GIF87a", "GIF89a"].includes(header.subarray(0, 6).toString("latin1")),
  },
  {
    extension: "webp",
    matches: (header) =>
      header.subarray(0, 4).toString("latin1") === "RIFF" &&
      header.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

const keys = (bytes: Buffer): InputSegment[] => (bytes.length === 0 ? [] : [{ kind: "keys", bytes }]);

export class BracketedPasteSplitter {
  private body: Buffer | undefined;

  push(chunk: Buffer): InputSegment[] {
    return this.body === undefined ? this.inKeys(chunk) : this.inPaste(Buffer.concat([this.body, chunk]));
  }

  flush(): InputSegment[] {
    const body = this.body;

    this.body = undefined;

    return body === undefined ? [] : keys(Buffer.concat([PASTE_START, body]));
  }

  private inKeys(data: Buffer): InputSegment[] {
    const start = data.indexOf(PASTE_START);

    if (start === -1) {
      return keys(Buffer.from(data));
    }

    return [
      ...keys(Buffer.from(data.subarray(0, start))),
      ...this.inPaste(data.subarray(start + PASTE_START.length)),
    ];
  }

  private inPaste(data: Buffer): InputSegment[] {
    const end = data.indexOf(PASTE_END);
    const size = end === -1 ? data.length : end;

    this.body = undefined;

    if (size > PASTE_MAX_BYTES) {
      return keys(Buffer.concat([PASTE_START, data]));
    }

    if (end === -1) {
      this.body = Buffer.from(data);

      return [];
    }

    return [
      { kind: "paste", body: Buffer.from(data.subarray(0, end)) },
      ...this.inKeys(data.subarray(end + PASTE_END.length)),
    ];
  }
}

const unescaped = (text: string) => text.replace(ESCAPED, "$1");

export const pathTokens = (text: string): PathToken[] =>
  [...text.matchAll(PATH_TOKEN)].map((match) => {
    const [whole, single, double, bare] = match;
    const start = match.index;
    const end = start + whole.length;

    if (single !== undefined) {
      return { start, end, path: single, quote: "'" };
    }

    return double === undefined
      ? { start, end, path: unescaped(bare ?? ""), quote: "" }
      : { start, end, path: unescaped(double), quote: '"' };
  });

export const withReplacedPaths = (text: string, replacements: Array<{ token: PathToken; path: string }>) =>
  [...replacements]
    .sort((left, right) => right.token.start - left.token.start)
    .reduce(
      (result, { token, path }) =>
        `${result.slice(0, token.start)}${token.quote}${path}${token.quote}${result.slice(token.end)}`,
      text,
    );

export const imageExtensionOf = (header: Buffer) =>
  IMAGE_SIGNATURES.find((signature) => signature.matches(header))?.extension;

export const bracketed = (body: Buffer) => Buffer.concat([PASTE_START, body, PASTE_END]);

export class OrderedInput {
  private tail: Promise<void> = Promise.resolve();

  private waiting = 0;

  private readonly write: (bytes: Buffer) => void;

  constructor(write: (bytes: Buffer) => void) {
    this.write = write;
  }

  push(bytes: Buffer) {
    if (this.waiting === 0) {
      this.write(bytes);

      return;
    }

    this.enqueue(Promise.resolve(bytes));
  }

  pushLater(bytes: Promise<Buffer>, fallback: Buffer) {
    this.enqueue(bytes.catch(() => fallback));
  }

  settled() {
    return this.tail;
  }

  private enqueue(bytes: Promise<Buffer>) {
    this.waiting += 1;

    this.tail = this.tail
      .then(() => bytes)
      .then((ready) => {
        this.write(ready);
      })
      .finally(() => {
        this.waiting -= 1;
      });
  }
}
