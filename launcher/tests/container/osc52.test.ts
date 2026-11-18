import { describe, expect, it } from "vitest";
import {
  OSC_OPENER_MAX_BYTES,
  OSC52_MAX_BYTES,
  Osc52Filter,
  type Osc52Segment,
} from "../../container/osc52.ts";

const BEL = "\x07";

const ST = "\x1b\\";

const copySequence = (text: string, terminator = BEL) =>
  `\x1b]52;c;${Buffer.from(text).toString("base64")}${terminator}`;

const run = (chunks: Buffer[]) => {
  const filter = new Osc52Filter();
  const segments = [...chunks.flatMap((chunk) => filter.push(chunk)), ...filter.flush()];
  const passed = Buffer.concat(
    segments.flatMap((segment) => (segment.kind === "pass" ? [segment.bytes] : [])),
  ).toString("latin1");
  const copies = segments
    .filter((segment): segment is Extract<Osc52Segment, { kind: "copy" }> => segment.kind === "copy")
    .map((segment) => ({
      text: segment.text.toString("utf8"),
      sequence: segment.sequence.toString("latin1"),
    }));

  return { passed, copies };
};

const whole = (text: string) => run([Buffer.from(text, "latin1")]);

const splitAt = (text: string, at: number) => {
  const bytes = Buffer.from(text, "latin1");

  return run([bytes.subarray(0, at), bytes.subarray(at)]);
};

const chunked = (bytes: Buffer, cuts: number[]) =>
  run([...cuts, bytes.length].map((cut, index) => bytes.subarray(cuts[index - 1] ?? 0, cut)));

const seeded = (seed: number) => {
  const state = { seed };

  return (limit: number) => {
    state.seed = (state.seed * 1_103_515_245 + 12_345) >>> 0;

    return (state.seed >>> 8) % limit;
  };
};

const isSkipped = (byte: number) =>
  (byte < 0x20 && byte !== 0x18 && byte !== 0x1a && byte !== 0x1b) || byte === 0x7f;

const skipped = (bytes: Buffer, from: number, skip: (byte: number) => boolean) => {
  const offset = bytes.subarray(from).findIndex((byte) => !skip(byte));

  return offset === -1 ? bytes.length : from + offset;
};

const opensOsc52 = (bytes: Buffer, at: number) => {
  const closer = bytes[at] === 0x1b ? 0x5d : bytes[at] === 0xc2 ? 0x9d : undefined;
  const introducer = skipped(bytes, at + 1, isSkipped);

  if (closer === undefined || bytes[introducer] !== closer) {
    return false;
  }

  const end = skipped(
    bytes,
    introducer + 1,
    (byte) => (isSkipped(byte) && byte !== 0x07) || (byte >= 0x30 && byte <= 0x39),
  );
  const digits = [...bytes.subarray(introducer + 1, end)].filter((byte) => byte >= 0x30 && byte <= 0x39);
  const value = digits.reduce((total, byte) => total * 10n + BigInt(byte - 0x30), 0n);

  return digits.length > 0 && [value, value % 65_536n, value % 4_294_967_296n].includes(52n);
};

const containsOsc52 = (text: string) => {
  const bytes = Buffer.from(text, "latin1");

  return bytes.some((_, at) => opensOsc52(bytes, at));
};

const ADVERSARIAL = [
  "\x1b\x07",
  "\x1b\x0e",
  "\x1b",
  "]",
  "\xc2",
  "\x9d",
  "\x9c",
  "5",
  "2",
  "52",
  "0",
  "7",
  ";",
  "c",
  "?",
  "aGk=",
  "QUJD",
  "\x07",
  "\\",
  "\x00",
  "\x01",
  "\r\n",
  "\x7f",
  "\x18",
  "\x1a",
  "plain",
  "\xc3\xa9",
  "\xe2\x80\x9d",
  "\x1b]52;",
  "\xc2\x9d52;",
];

const HARMLESS = [
  "\x1b[1m",
  "\x1b]0;t\x07",
  "\x1b]8;;u\x1b\\",
  "\x1b]133;A\x07",
  "\x1b]520;x\x07",
  "\x1b]53;x\x07",
  "\x1b]5;x\x07",
  "\x1b\x1b[m",
  "\x1b\x00[m",
  "\x1b\x18",
  "\xc2\xa9",
  "\xe2\x80\x9d",
  "\xc3\x9c",
  "\x9c",
  "\x9d",
  "text",
  "\r\n",
  "\x07",
  "\xc2\x9d0;t\x07",
  "\x1b]1337;Copy=:aGk=\x07",
];

const generated = (random: (limit: number) => number, alphabet: string[]) =>
  Buffer.from(
    Array.from({ length: 1 + random(24) }, () => alphabet[random(alphabet.length)]).join(""),
    "latin1",
  );

const randomCuts = (random: (limit: number) => number, length: number) =>
  [...new Set(Array.from({ length: random(8) }, () => random(length + 1)))].sort(
    (left, right) => left - right,
  );

const everyBoundary = (text: string) =>
  Array.from({ length: Buffer.byteLength(text, "latin1") + 1 }, (_, at) => splitAt(text, at));

describe("Osc52Filter", () => {
  it("drops a BEL-terminated copy and returns its text", () => {
    const sequence = copySequence("héllo");

    expect(whole(`before${sequence}after`)).toEqual({
      passed: "beforeafter",
      copies: [{ text: "héllo", sequence }],
    });
  });

  it("drops an ST-terminated copy", () => {
    expect(whole(`a${copySequence("text", ST)}b`)).toEqual({
      passed: "ab",
      copies: [{ text: "text", sequence: copySequence("text") }],
    });
  });

  it("finds a copy split at every byte boundary, with either terminator", () => {
    [BEL, ST].forEach((terminator) => {
      const text = `\x1b[31mred${copySequence("split me", terminator)}\x1b[0m`;
      const sequence = copySequence("split me");

      everyBoundary(text).forEach((result) => {
        expect(result).toEqual({ passed: "\x1b[31mred\x1b[0m", copies: [{ text: "split me", sequence }] });
      });
    });
  });

  it("finds a copy fed one byte at a time", () => {
    const bytes = Buffer.from(`x${copySequence("bytes", ST)}y`, "latin1");

    expect(run([...bytes].map((byte) => Buffer.from([byte])))).toEqual({
      passed: "xy",
      copies: [{ text: "bytes", sequence: copySequence("bytes") }],
    });
  });

  it("drops a read query and never reports it", () => {
    [`\x1b]52;c;?${BEL}`, `\x1b]52;;?${ST}`].forEach((query) => {
      everyBoundary(`a${query}b`).forEach((result) => {
        expect(result).toEqual({ passed: "ab", copies: [] });
      });
    });
  });

  it("passes other output through byte for byte", () => {
    const text =
      "\x1b[2J\x1b]0;title\x07\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\\x1b]5;x\x07plain \x1b\x1b[0m";

    everyBoundary(text).forEach((result) => {
      expect(result).toEqual({ passed: text, copies: [] });
    });
  });

  it("drops every query variant whole", () => {
    [
      `\x1b]52;c\x01;?${BEL}`,
      `\x1b]52;x;?${BEL}`,
      "\x1b]52;c;?\x9c;?\x07",
      "\x1b]52;c;?\x18",
      "\x1b]52;c;?\x1a",
    ].forEach((query) => {
      everyBoundary(`a${query}b`).forEach((result) => {
        expect(result).toEqual({ passed: "ab", copies: [] });
      });
    });
  });

  it("drops a query cut short by another escape and parses that escape", () => {
    everyBoundary("a\x1b]52;c;?\x1b[0mb").forEach((result) => {
      expect(result).toEqual({ passed: "a\x1b[0mb", copies: [] });
    });
  });

  it("drops malformed sequences", () => {
    [
      `\x1b]52;c;not base64!${BEL}`,
      `\x1b]52;c;QUJ${BEL}`,
      `\x1b]52;zz;QUJD${BEL}`,
      `\x1b]52;QUJD${BEL}`,
      `\x1b]52${BEL}`,
      "\x1b]52;c;QUJD\x18",
    ].forEach((text) => {
      expect(whole(`a${text}b`)).toEqual({ passed: "ab", copies: [] });
    });
  });

  it("drops a well-formed write that another escape cuts short", () => {
    expect(whole("a\x1b]52;c;QUJD\x1bXb")).toEqual({ passed: "a\x1bXb", copies: [] });
  });

  it("leaves other OSC numbers that start with 5 alone", () => {
    const text = `\x1b]520;c;?${BEL}\x1b]5;c;?${BEL}\x1b]53;x${ST}`;

    everyBoundary(text).forEach((result) => {
      expect(result).toEqual({ passed: text, copies: [] });
    });
  });

  it("rebuilds the forwarded sequence from the validated fields", () => {
    expect(whole(`\x1b]52;p;QUJD${ST}`).copies).toEqual([{ text: "ABC", sequence: `\x1b]52;p;QUJD${BEL}` }]);
  });

  it("discards a sequence over the size cap until its terminator", () => {
    const text = `\x1b]52;c;${"A".repeat(OSC52_MAX_BYTES + 8)}${BEL}after`;
    const bytes = Buffer.from(text, "latin1");
    const chunks = Array.from({ length: Math.ceil(bytes.length / 4096) }, (_, index) =>
      bytes.subarray(index * 4096, (index + 1) * 4096),
    );

    expect(run(chunks)).toEqual({ passed: "after", copies: [] });
  });

  it("drops read queries in every opener spelling, split anywhere", () => {
    [
      `\x1b]5\x012;c;?${BEL}`,
      `\x1b]52\x00;c;?${BEL}`,
      `\x1b\x00]52;c;?${BEL}`,
      `\x1b]052;c;?${BEL}`,
      `\x1b]0052;c;?${BEL}`,
      `\xc2\x9d52;c;?${BEL}`,
      `\xc2\x9d52;c;?${ST}`,
    ].forEach((query) => {
      everyBoundary(`a${query}b`).forEach((result) => {
        expect(result).toEqual({ passed: "ab", copies: [] });
      });
    });
  });

  it("copies a write opened by the UTF-8 C1 introducer or with leading zeros", () => {
    [`\xc2\x9d52;c;aGk=${BEL}`, `\x1b]052;c;aGk=${BEL}`].forEach((write) => {
      everyBoundary(`a${write}b`).forEach((result) => {
        expect(result).toEqual({ passed: "ab", copies: [{ text: "hi", sequence: `\x1b]52;c;aGk=${BEL}` }] });
      });
    });
  });

  it("drops a write whose body holds a C0 byte", () => {
    expect(whole(`a\x1b]52;c;aG\x00k=${BEL}b`)).toEqual({ passed: "ab", copies: [] });
  });

  it("fails closed on an opener longer than the cap", () => {
    expect(whole(`a\x1b]${"0".repeat(OSC_OPENER_MAX_BYTES)}52;c;?${BEL}b`)).toEqual({
      passed: "ab",
      copies: [],
    });
  });

  it("passes other OSCs byte for byte, split anywhere", () => {
    [
      `\x1b]520;c;?${BEL}`,
      `\x1b]5;c;?${BEL}`,
      `\x1b]53;x${ST}`,
      `\x1b]8;;https://x${ST}`,
      `\x1b]0;title${BEL}`,
      `\x1b]133;A${BEL}`,
      `\x1b]1337;Copy=:aGk=${BEL}`,
      `\x1b]5522;type=write${BEL}`,
    ].forEach((text) => {
      everyBoundary(`a${text}b`).forEach((result) => {
        expect(result).toEqual({ passed: `a${text}b`, copies: [] });
      });
    });
  });

  it("passes text with 0x9c and 0x9d continuation bytes, split mid-character", () => {
    const text = Buffer.from("\u201cquoted\u201d Ü © °", "utf8").toString("latin1");

    everyBoundary(text).forEach((result) => {
      expect(result).toEqual({ passed: text, copies: [] });
    });
  });

  it("scans 200,000 escape sequences in one chunk", () => {
    const text = "\x1b[m".repeat(200_000);

    expect(whole(text)).toEqual({ passed: text, copies: [] });
  });

  it("scans 20,000 copies in one chunk", () => {
    const { passed, copies } = whole(`\x1b]52;c;aGk=${BEL}x`.repeat(20_000));

    expect(passed).toBe("x".repeat(20_000));
    expect(copies).toHaveLength(20_000);
  });

  it("takes linear time on a large chunk", () => {
    const timed = (count: number) => {
      const started = performance.now();

      whole("\x1b[mx".repeat(count));

      return performance.now() - started;
    };

    timed(50_000);

    expect(timed(400_000)).toBeLessThan(Math.max(timed(100_000), 5) * 12);
  });

  it("never forwards a prefix that a dropped sequence could splice into OSC 52", () => {
    const pwned = "]52;c;cHduZWQ=\x07";

    [
      `\x1b\x1b]52;c;x\x07${pwned}`,
      `\x1b\x00\x1b]52;c;x\x07${pwned}`,
      `\x1b]\x1b]52;c;x\x07${pwned.slice(1)}`,
      `\x1b]5\x1b]52;c;x\x07${pwned.slice(2)}`,
      `\xc2\x1b]52;c;x\x07\x9d${pwned.slice(1)}`,
      `\xc2\xc2\x9d52;c;x\x07\x9d${pwned.slice(1)}`,
      `\x1b\xc2\x9d52;c;x\x07${pwned}`,
      `\x1b]52;c;x\x1b\x1b]52;c;y\x07${pwned}`,
    ].forEach((text) => {
      everyBoundary(text).forEach((result) => {
        const again = whole(result.passed);

        expect(result.copies).toEqual([]);
        expect(again).toEqual({ passed: result.passed, copies: [] });
      });
    });
  });

  it("consumes OSC numbers above 65535 and reads DEL as ignorable in the number", () => {
    ["\x1b]65588;c;cHduZWQ=\x07", "\x1b]4294967348;c;?\x07"].forEach((text) => {
      expect(whole(`a${text}b`)).toEqual({ passed: "ab", copies: [] });
    });

    expect(whole("\x1b]5\x7f2;c;?\x07").passed).toBe("");
  });

  it("forwards the controls of an escape that runs over the cap and keeps the text", () => {
    const text = `\x1b${"\r\n".repeat(9)}hello world\n`;

    everyBoundary(text).forEach((result) => {
      expect(result).toEqual({ passed: `${"\r\n".repeat(9)}hello world\n`, copies: [] });
    });
  });

  it("holds BEL and other executed controls between ESC and the bracket", () => {
    [`\x1b\x07]52;c;cHduZWQ=${BEL}`, `\x1b\x00\x07]52;c;?${BEL}`, `\xc2\x07\x9d52;c;?${BEL}`].forEach(
      (text) => {
        everyBoundary(`a${text}b`).forEach((result) => {
          expect(result.copies).toHaveLength(text.includes("cHdu") ? 1 : 0);
          expect(containsOsc52(result.passed)).toBe(false);
        });
      },
    );

    ["\x1b\x07[1m", "\x1b\x07x", "\x1b\x0e[1m"].forEach((text) => {
      everyBoundary(text).forEach((result) => {
        expect(result).toEqual({ passed: text, copies: [] });
      });
    });
  });

  it("is idempotent and chunking invariant on adversarial streams", () => {
    const random = seeded(52);

    Array.from({ length: 3000 }).forEach(() => {
      const bytes = generated(random, ADVERSARIAL);
      const reference = chunked(bytes, []);
      const again = whole(reference.passed);

      expect(again).toEqual({ passed: reference.passed, copies: [] });
      expect(containsOsc52(reference.passed)).toBe(false);
      expect(chunked(bytes, randomCuts(random, bytes.length))).toEqual(reference);
      expect(
        chunked(
          bytes,
          Array.from({ length: bytes.length - 1 }, (_, index) => index + 1),
        ),
      ).toEqual(reference);
    });
  });

  it("passes streams with no way to form OSC 52 byte for byte", () => {
    const random = seeded(7);

    Array.from({ length: 2000 }).forEach(() => {
      const bytes = Buffer.concat([generated(random, HARMLESS), Buffer.from("x")]);
      const text = bytes.toString("latin1");

      expect(chunked(bytes, randomCuts(random, bytes.length))).toEqual({ passed: text, copies: [] });
    });
  });

  it("accepts a sequence at pi's own cap", () => {
    const payload = "A".repeat(100_000);
    const text = `\x1b]52;c;${payload}${BEL}`;

    expect(whole(text).copies).toHaveLength(1);
    expect(whole(text).passed).toBe("");
  });

  it("drops a partial sequence left at the end of the stream", () => {
    const filter = new Osc52Filter();

    expect(filter.push(Buffer.from("ok\x1b]52;c;QU"))).toEqual([{ kind: "pass", bytes: Buffer.from("ok") }]);
    expect(filter.flush()).toEqual([]);
  });

  it("drops a partial opener left at the end of the stream", () => {
    const filter = new Osc52Filter();

    expect(filter.push(Buffer.from("ok\x1b]5"))).toEqual([{ kind: "pass", bytes: Buffer.from("ok") }]);
    expect(filter.flush()).toEqual([]);
  });

  it("holds nothing back when no candidate is open", () => {
    const filter = new Osc52Filter();

    expect(filter.push(Buffer.from("\x1b[1mbold"))).toEqual([
      { kind: "pass", bytes: Buffer.from("\x1b[1mbold") },
    ]);
    expect(filter.flush()).toEqual([]);
  });
});
