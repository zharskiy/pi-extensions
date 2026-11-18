import { describe, expect, it } from "vitest";
import {
  BracketedPasteSplitter,
  type InputSegment,
  imageExtensionOf,
  OrderedInput,
  PASTE_MAX_BYTES,
  type PathToken,
  pathTokens,
  withReplacedPaths,
} from "../../container/paste.ts";

const START = "\x1b[200~";

const END = "\x1b[201~";

const shown = (segments: InputSegment[]) =>
  segments.map((segment) =>
    segment.kind === "keys" ? { keys: segment.bytes.toString() } : { paste: segment.body.toString() },
  );

const split = (chunks: string[]) => {
  const splitter = new BracketedPasteSplitter();

  return shown([...chunks.flatMap((chunk) => splitter.push(Buffer.from(chunk))), ...splitter.flush()]);
};

describe("BracketedPasteSplitter", () => {
  it("passes keys through as they come", () => {
    expect(split(["a", "\x1b", "[A"])).toEqual([{ keys: "a" }, { keys: "\x1b" }, { keys: "[A" }]);
  });

  it("cuts a paste out of the keys around it", () => {
    expect(split([`x${START}/a.png${END}y`])).toEqual([{ keys: "x" }, { paste: "/a.png" }, { keys: "y" }]);
  });

  it("buffers a paste split after its start marker at every byte", () => {
    const tail = `/Users/me/Shot.png${END}z`;

    Array.from({ length: tail.length + 1 }, (_, at) => at).forEach((at) => {
      const result = split([`${START}${tail.slice(0, at)}`, tail.slice(at)]);

      expect(result.filter((entry) => "paste" in entry)).toEqual([{ paste: "/Users/me/Shot.png" }]);
      expect(result.at(-1)).toEqual({ keys: "z" });
    });
  });

  it("leaves a paste whose start marker is split as plain keys", () => {
    expect(split(["\x1b[20", `0~/a.png${END}`])).toEqual([{ keys: "\x1b[20" }, { keys: `0~/a.png${END}` }]);
  });

  it("passes a paste over the cap through unchanged", () => {
    const body = "x".repeat(PASTE_MAX_BYTES + 1);
    const result = split([`${START}${body.slice(0, 10)}`, `${body.slice(10)}${END}k`]);

    expect(result.map((entry) => ("keys" in entry ? entry.keys : "")).join("")).toBe(
      `${START}${body}${END}k`,
    );
    expect(result.some((entry) => "paste" in entry)).toBe(false);
  });

  it("flushes an unfinished paste as keys at the end", () => {
    expect(split([`${START}/a`])).toEqual([{ keys: `${START}/a` }]);
  });
});

describe("pathTokens", () => {
  it("reads backslash-escaped, quoted and plain paths", () => {
    const text = `/var/folders/x/My\\ Shot\\ 1.png '/tmp/a b.png' "/tmp/c \\"d\\".png" /plain.png`;

    expect(pathTokens(text).map(({ path, quote }) => ({ path, quote }))).toEqual([
      { path: "/var/folders/x/My Shot 1.png", quote: "" },
      { path: "/tmp/a b.png", quote: "'" },
      { path: '/tmp/c "d".png', quote: '"' },
      { path: "/plain.png", quote: "" },
    ]);
  });

  it("skips relative paths and words that only contain a slash", () => {
    expect(pathTokens("see a/b.png and x/y, then ./c.png")).toEqual([]);
  });

  it("replaces tokens in any style and keeps the rest", () => {
    const text = "look at /a\\ b.png and '/c d.png'\n";
    const [first, second] = pathTokens(text) as [PathToken, PathToken];
    const replaced = withReplacedPaths(text, [
      { token: first, path: "/tmp/pi-paste/1.png" },
      { token: second, path: "/tmp/pi-paste/2.png" },
    ]);

    expect(replaced).toBe("look at /tmp/pi-paste/1.png and '/tmp/pi-paste/2.png'\n");
  });
});

describe("imageExtensionOf", () => {
  it("knows PNG, JPEG, GIF and WebP by their magic bytes", () => {
    expect(imageExtensionOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe(
      "png",
    );
    expect(imageExtensionOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(imageExtensionOf(Buffer.from("GIF89a......"))).toBe("gif");
    expect(imageExtensionOf(Buffer.from("RIFF\0\0\0\0WEBP"))).toBe("webp");
    expect(imageExtensionOf(Buffer.from("%PDF-1.7"))).toBeUndefined();
    expect(imageExtensionOf(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("OrderedInput", () => {
  it("writes at once while nothing waits, and after a pending paste otherwise", async () => {
    const written: string[] = [];
    const ordered = new OrderedInput((bytes) => written.push(bytes.toString()));
    const gate: { open: (bytes: Buffer) => void } = { open: () => undefined };
    const later = new Promise<Buffer>((resolve) => {
      gate.open = resolve;
    });

    ordered.push(Buffer.from("a"));

    expect(written).toEqual(["a"]);

    ordered.pushLater(later, Buffer.from("raw"));

    ordered.push(Buffer.from("b"));

    expect(written).toEqual(["a"]);

    gate.open(Buffer.from("paste"));

    await ordered.settled();

    ordered.push(Buffer.from("c"));

    expect(written).toEqual(["a", "paste", "b", "c"]);
  });

  it("writes the fallback when the pending bytes fail", async () => {
    const written: string[] = [];
    const ordered = new OrderedInput((bytes) => written.push(bytes.toString()));

    ordered.pushLater(Promise.reject(new Error("boom")), Buffer.from("raw"));

    ordered.push(Buffer.from("k"));

    await ordered.settled();

    expect(written).toEqual(["raw", "k"]);
  });
});
