import { describe, expect, it } from "vitest";
import {
  errorText,
  formatCost,
  formatDuration,
  formatMoney,
  formatTokens,
  formatWindow,
  homeRelative,
} from "../format.ts";

describe("shared formatters", () => {
  it("formats tokens as 999, 1.0k, 1.2M", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1_234_567)).toBe("1.2M");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect([999_949, 999_950, 999_999].map(formatTokens)).toEqual(["999.9k", "1.0M", "1.0M"]);
    expect([150_100, 1_000_000, 2_450_000].map(formatTokens)).toEqual(["150.1k", "1.0M", "2.5M"]);
  });

  it("formats context windows in whole thousands or tenths of a million", () => {
    expect([512, 200_000, 128_500, 1_000_000, 1_048_576, 1_500_000].map(formatWindow)).toEqual([
      "512",
      "200k",
      "129k",
      "1M",
      "1.0M",
      "1.5M",
    ]);
  });

  it("formats durations as seconds, minutes and hours", () => {
    expect(formatDuration(3_000)).toBe("3s");
    expect(formatDuration(75_000)).toBe("1m 15s");
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(62_000)).toBe("1m 2s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
    expect(formatDuration(-5)).toBe("0s");
  });

  it("reads the message of an error and stringifies anything else", () => {
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText("plain")).toBe("plain");
    expect(errorText(undefined)).toBe("undefined");
  });

  it("shortens paths under the home directory to ~ and leaves others alone", () => {
    expect(homeRelative("/home/me/.pi/agent/mcp.json", "/home/me")).toBe("~/.pi/agent/mcp.json");
    expect(homeRelative("/home/me", "/home/me")).toBe("~");
    expect(homeRelative("/home/meow/x", "/home/me")).toBe("/home/meow/x");
    expect(homeRelative("/home/me/x", "")).toBe("/home/me/x");
  });
});

describe("costs and calls", () => {
  it("formats money with two decimals, <$0.01 for fractions and omits or shows zero", () => {
    expect([0.004, 0.04, 12.3, 4.4249].map((usd) => formatCost(usd))).toEqual([
      "<$0.01",
      "$0.04",
      "$12.30",
      "$4.42",
    ]);
    expect(formatCost(0)).toBeUndefined();
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(12.3)).toBe("$12.30");
  });
});
