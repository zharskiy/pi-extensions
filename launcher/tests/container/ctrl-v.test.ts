import { describe, expect, it } from "vitest";
import { CtrlVScanner, ctrlVCandidate, type KeySegment } from "../../container/ctrl-v.ts";

const ACCEPTED = [
  "\x16",
  "\x1b[118;5u",
  "\x1b[118;69u",
  "\x1b[118;133u",
  "\x1b[118;197u",
  "\x1b[118;5:1u",
  "\x1b[118;5:2u",
  "\x1b[118;69:2u",
  "\x1b[118:86;5u",
  "\x1b[118:;5u",
  "\x1b[118:86:118;5u",
  "\x1b[118::118;5u",
  "\x1b[118::1084;5u",
  "\x1b[1084::118;5u",
  "\x1b[1084:1052:118;5:1u",
  "\x1b[27;5;118~",
];

const NEAR_MISSES = [
  "\x1b[118;6u",
  "\x1b[118;5:3u",
  "\x1b[118;69:3u",
  "\x1b[118;5~",
  "\x1b[119;5u",
  "\x1b[86;5u",
  "\x1b[118u",
  "\x1b[118;1u",
  "\x1b[118;13u",
  "\x1b[0118;5u",
  "\x1b[118;05u",
  "\x1b[118;5:0u",
  "\x1b[118::;5u",
  "\x1b[99::118;5u",
  "\x1b[47::118;5u",
  "\x1b[1084;5u",
  "\x1b[1084::119;5u",
  "\x1b[1084:118;5u",
  "\x1b[27;6;118~",
  "\x1b[27;5;119~",
  "\x1b[27;5;118u",
  "\x1b[27;69;118~",
  "\x1b[?118;5u",
  "\x1b[118;5;1u",
  "\x1b[1;5A",
  "\x1b\x16",
  "\x1b\x1b[118;5:3u",
  "\x1b\x1b[",
  "\x1bO\x16",
  "\x1b[1\x16u",
  "\x1b[1\x1b[118;5u",
  "\x1b]0;\x16\x07",
  "\x1b]11;\x1b[118;5u\x07",
  "\x1bP1$r\x16\x1b\\",
  "\x1b_Gi=1;\x1b[118;5u\x1b\\",
  "\x1b[M\x16\x16\x16",
  "\x1b[<0;1u\x16",
];

const scan = (...chunks: string[]) => {
  const scanner = new CtrlVScanner();

  return chunks.flatMap((chunk) => scanner.push(Buffer.from(chunk, "latin1")));
};

const shown = (segments: KeySegment[]) =>
  segments.map((segment) => ({ kind: segment.kind, text: segment.bytes.toString("latin1") }));

const merged = (segments: KeySegment[]) =>
  shown(segments).filter((segment, index, all) => {
    const next = all[index + 1];

    if (segment.kind === "keys" && next?.kind === "keys") {
      next.text = `${segment.text}${next.text}`;

      return false;
    }

    return true;
  });

describe("CtrlVScanner", () => {
  it("finds ctrl+v in every encoding pi reads it in", () => {
    ACCEPTED.forEach((form) => {
      expect(shown(scan(`a${form}b`))).toEqual([
        { kind: "keys", text: "a" },
        { kind: "ctrlV", text: form },
        { kind: "keys", text: "b" },
      ]);
    });
  });

  it("passes near misses, releases and ctrl+v bytes inside other sequences through untouched", () => {
    NEAR_MISSES.forEach((miss) => {
      expect(merged(scan(`a${miss}b`))).toEqual([{ kind: "keys", text: `a${miss}b` }]);
    });
  });

  it("finds a ctrl+v split at any byte but right after its escape or its CSI opener", () => {
    ACCEPTED.forEach((form) => {
      const input = `ab${form}cd`;

      Array.from({ length: input.length - 1 }, (_, index) => index + 1).forEach((cut) => {
        const segments = merged(scan(input.slice(0, cut), input.slice(cut)));
        const afterBareOpener = form.startsWith("\x1b") && (cut === 3 || cut === 4);

        expect(segments).toEqual(
          afterBareOpener
            ? [{ kind: "keys", text: input }]
            : [
                { kind: "keys", text: "ab" },
                { kind: "ctrlV", text: form },
                { kind: "keys", text: "cd" },
              ],
        );
      });
    });
  });

  it("finds a ctrl+v split into three chunks and passes it byte by byte after a bare escape", () => {
    expect(merged(scan("\x1b[1", "18;", "5u"))).toEqual([{ kind: "ctrlV", text: "\x1b[118;5u" }]);
    expect(merged(scan(..."\x1b[118;5u"))).toEqual([{ kind: "keys", text: "\x1b[118;5u" }]);
  });

  it("never holds a bare escape or CSI opener at the end of a chunk and starts over after it", () => {
    const scanner = new CtrlVScanner();

    expect(shown(scanner.push(Buffer.from("x\x1b")))).toEqual([{ kind: "keys", text: "x\x1b" }]);
    expect(scanner.waiting()).toBe(false);
    expect(shown(scanner.push(Buffer.from("]\x16")))).toEqual([
      { kind: "keys", text: "]" },
      { kind: "ctrlV", text: "\x16" },
    ]);
    expect(shown(scanner.push(Buffer.from("\x1b[")))).toEqual([{ kind: "keys", text: "\x1b[" }]);
    expect(scanner.waiting()).toBe(false);
    expect(shown(scanner.push(Buffer.from("a")))).toEqual([{ kind: "keys", text: "a" }]);
    expect(shown(scanner.push(Buffer.from("\x1b\x1b")))).toEqual([{ kind: "keys", text: "\x1b\x1b" }]);
    expect(shown(scanner.push(Buffer.from("[118;5u")))).toEqual([{ kind: "keys", text: "[118;5u" }]);
  });

  it("reads ESC ESC before a sequence opener as an escape and the sequence, as pi does", () => {
    expect(shown(scan("\x1b\x1b[118;5u"))).toEqual([
      { kind: "keys", text: "\x1b" },
      { kind: "ctrlV", text: "\x1b[118;5u" },
    ]);
    expect(shown(scan("\x1b\x1b\x16"))).toEqual([
      { kind: "keys", text: "\x1b\x1b" },
      { kind: "ctrlV", text: "\x16" },
    ]);
    expect(merged(scan("\x1b\x1b]0;\x16\x07\x1b\x1bO\x16"))).toEqual([
      { kind: "keys", text: "\x1b\x1b]0;\x16\x07\x1b\x1bO\x16" },
    ]);
  });

  it("holds a string without a terminal reply header and rescans it after the opener when idle", () => {
    const scanner = new CtrlVScanner();

    expect(scanner.push(Buffer.from("\x1b]"))).toEqual([]);
    expect(scanner.push(Buffer.from("a\x16b"))).toEqual([]);
    expect(shown(scanner.idle())).toEqual([
      { kind: "keys", text: "\x1b]a" },
      { kind: "ctrlV", text: "\x16" },
      { kind: "keys", text: "b" },
    ]);
    expect(scanner.waiting()).toBe(false);
    expect(scanner.push(Buffer.from("\x1bP\x1b[118;"))).toEqual([]);
    expect(shown(scanner.idle())).toEqual([{ kind: "keys", text: "\x1bP" }]);
    expect(shown(scanner.push(Buffer.from("5u")))).toEqual([{ kind: "ctrlV", text: "\x1b[118;5u" }]);
  });

  it("releases a held string unscanned at its terminator or past the hold limit", () => {
    const scanner = new CtrlVScanner();

    expect(scanner.push(Buffer.from("\x1bP1$r\x16"))).toEqual([]);
    expect(shown(scanner.push(Buffer.from("m\x1b\\")))).toEqual([
      { kind: "keys", text: "\x1bP1$r\x16m\x1b\\" },
    ]);

    const long = `\x1b]l${"t".repeat(1100)}\x16`;

    expect(merged(scan(long))).toEqual([{ kind: "keys", text: long }]);
  });

  it("never scans a string that starts with a terminal reply header, even when idle", () => {
    ["\x1b]11;", "\x1b]4;12;", "\x1b]7501;?", "\x1bP>|", "\x1b_Gi=1,p=2;"].forEach((header) => {
      const scanner = new CtrlVScanner();

      expect(shown(scanner.push(Buffer.from(`${header}x\x16`)))).toEqual([
        { kind: "keys", text: `${header}x\x16` },
      ]);
      expect(scanner.idle()).toEqual([]);
      expect(shown(scanner.push(Buffer.from("\x16")))).toEqual([{ kind: "ctrlV", text: "\x16" }]);
    });
  });

  it("holds only a prefix that can still become ctrl+v and releases it on the next byte", () => {
    const scanner = new CtrlVScanner();

    expect(scanner.push(Buffer.from("\x1b[11"))).toEqual([]);
    expect(shown(scanner.push(Buffer.from("x")))).toEqual([{ kind: "keys", text: "\x1b[11x" }]);
    expect(shown(scanner.push(Buffer.from("\x1b[1;")))).toEqual([{ kind: "keys", text: "\x1b[1;" }]);
    expect(shown(scanner.push(Buffer.from("5A\x1b[118;7")))).toEqual([
      { kind: "keys", text: "5A\x1b[118;7" },
    ]);
  });

  it("releases a held prefix when idle and forgets the sequence on the next idle", () => {
    const scanner = new CtrlVScanner();

    expect(scanner.push(Buffer.from("\x1b[118;"))).toEqual([]);
    expect(shown(scanner.idle())).toEqual([{ kind: "keys", text: "\x1b[118;" }]);
    expect(scanner.waiting()).toBe(true);
    expect(shown(scanner.push(Buffer.from("5u")))).toEqual([{ kind: "keys", text: "5u" }]);

    scanner.push(Buffer.from("\x1b]11;"));

    expect(scanner.idle()).toEqual([]);
    expect(scanner.waiting()).toBe(false);
    expect(shown(scanner.push(Buffer.from("\x16")))).toEqual([{ kind: "ctrlV", text: "\x16" }]);
  });

  it("ignores ctrl+v inside a bracketed paste that reaches it as keys", () => {
    expect(merged(scan("\x1b[200~a\x16\x1b[118;5u", "b\x1b[20", "1~\x16"))).toEqual([
      { kind: "keys", text: "\x1b[200~a\x16\x1b[118;5ub\x1b[201~" },
      { kind: "ctrlV", text: "\x16" },
    ]);
    expect(merged(scan("\x1b", "[200~\x16\x1b[201~\x16"))).toEqual([
      { kind: "keys", text: "\x1b[200~\x16\x1b[201~" },
      { kind: "ctrlV", text: "\x16" },
    ]);
  });

  it("starts fresh after a paste the splitter took out", () => {
    const scanner = new CtrlVScanner();

    expect(scanner.push(Buffer.from("\x1b]0;"))).toEqual([]);
    expect(shown(scanner.pasted())).toEqual([{ kind: "keys", text: "\x1b]0;" }]);
    expect(shown(scanner.push(Buffer.from("\x16")))).toEqual([{ kind: "ctrlV", text: "\x16" }]);
    expect(scanner.push(Buffer.from("\x1b[118"))).toEqual([]);
    expect(shown(scanner.pasted())).toEqual([{ kind: "keys", text: "\x1b[118" }]);
  });

  it("follows complete mouse reports and string terminators back to keys", () => {
    expect(merged(scan("\x1b[<0;10;20M\x16"))).toEqual([
      { kind: "keys", text: "\x1b[<0;10;20M" },
      { kind: "ctrlV", text: "\x16" },
    ]);
    expect(merged(scan("\x1b[M abc\x16"))).toEqual([
      { kind: "keys", text: "\x1b[M abc" },
      { kind: "ctrlV", text: "\x16" },
    ]);
    expect(merged(scan("\x1b]11;rgb:0/0/0\x1b\\\x16\x1bP>|t\x1b\\\x16"))).toEqual([
      { kind: "keys", text: "\x1b]11;rgb:0/0/0\x1b\\" },
      { kind: "ctrlV", text: "\x16" },
      { kind: "keys", text: "\x1bP>|t\x1b\\" },
      { kind: "ctrlV", text: "\x16" },
    ]);
  });

  it("releases what it holds on flush", () => {
    const scanner = new CtrlVScanner();

    scanner.push(Buffer.from("\x1b[27;5"));

    expect(shown(scanner.flush())).toEqual([{ kind: "keys", text: "\x1b[27;5" }]);
  });

  it("scans long input without holding it", () => {
    const long = `${"\x1b[".repeat(50_000)}${"x".repeat(200_000)}\x16`;
    const segments = merged(scan(long));

    expect(segments.map((segment) => segment.kind)).toEqual(["keys", "ctrlV"]);
    expect(segments[0]?.text.length).toBe(long.length - 1);
  });
});

describe("ctrlVCandidate", () => {
  it("tells prefixes, matches and dead ends apart", () => {
    expect(
      ["1", "11", "118", "118;", "118;1", "118;19", "118;5:", "2", "27;5;", "1084:", "1084::11"].map(
        ctrlVCandidate,
      ),
    ).toEqual(Array(11).fill("prefix"));
    expect(
      ["0", "118;7", "118;5:3", "27;6", "1084;", "1084::2", "99::", `${"1".repeat(8)}`].map(ctrlVCandidate),
    ).toEqual(Array(8).fill("none"));
    expect(ctrlVCandidate("118;5u")).toBe("match");
  });
});

const ATOMS = [
  ...ACCEPTED,
  ...NEAR_MISSES,
  "\x1b",
  "\x1b[",
  "\x1b]",
  "\x1b\\",
  "\x07",
  "\x1b[200~",
  "\x1b[201~",
  "\x1b[<",
  "M",
  "u",
  "~",
  ";",
  ":",
  "1",
  "5",
  "118",
  "a",
];

const seeded = (seed: number) => {
  const state = { value: seed };

  return () => {
    state.value = (state.value * 1_103_515_245 + 12_345) % 2_147_483_648;

    return state.value / 2_147_483_648;
  };
};

const randomInput = (random: () => number) =>
  Array.from(
    { length: 1 + Math.floor(random() * 12) },
    () => ATOMS[Math.floor(random() * ATOMS.length)],
  ).join("");

const chunked = (input: string, random: () => number) => {
  const cuts = [...input].flatMap((_, index) =>
    index > 0 && input[index - 1] !== "\x1b" && input.slice(index - 2, index) !== "\x1b[" && random() < 0.3
      ? [index]
      : [],
  );

  return [0, ...cuts].map((start, index) => input.slice(start, cuts[index] ?? input.length));
};

describe("CtrlVScanner properties", () => {
  it("loses no byte and finds the same keys however the input is chunked", () => {
    const random = seeded(7);

    Array.from({ length: 3000 }).forEach(() => {
      const input = randomInput(random);
      const whole = new CtrlVScanner();
      const split = new CtrlVScanner();
      const once = [...whole.push(Buffer.from(input, "latin1")), ...whole.flush()];
      const parts = [
        ...chunked(input, random).flatMap((chunk) => split.push(Buffer.from(chunk, "latin1"))),
        ...split.flush(),
      ];

      expect(Buffer.concat(once.map((segment) => segment.bytes)).toString("latin1")).toBe(input);
      expect(merged(parts)).toEqual(merged(once));
      once
        .filter((segment) => segment.kind === "ctrlV")
        .forEach((segment) => {
          expect(ACCEPTED).toContain(segment.bytes.toString("latin1"));
        });
    });
  });
});
