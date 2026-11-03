import { describe, expect, it } from "vitest";
import { sha256Hex, stableHash } from "../../shared/index.ts";

describe("sha256Hex", () => {
  it("returns the lowercase hex digest of the input", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("stableHash", () => {
  it("ignores key order and undefined values at every depth", () => {
    expect(stableHash({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(stableHash({ a: { d: [1, 2] }, b: 1 }));
  });

  it("keeps array order significant", () => {
    expect(stableHash([1, 2])).not.toBe(stableHash([2, 1]));
  });
});
