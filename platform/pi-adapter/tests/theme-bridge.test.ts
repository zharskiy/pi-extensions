import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { plainPiTheme } from "../../../test/framework/pi/index.ts";
import type { ThemeToken } from "../index.ts";
import { themeLike } from "../ui/theme-bridge.ts";

initTheme("dark", false);

const theme = plainPiTheme;

describe("themeLike colours", () => {
  it("paints every role token with pi's theme colour of the same name", async () => {
    const recording = { fg: (token: string, text: string) => `<${token}>${text}` } as unknown as Theme;
    const like = themeLike(recording);
    const live = themeLike((await themeModule()).theme);
    const tokens = Object.keys({
      accent: true,
      border: true,
      borderAccent: true,
      syntaxString: true,
      syntaxVariable: true,
      muted: true,
      dim: true,
      success: true,
      warning: true,
      error: true,
      text: true,
      thinkingOff: true,
      thinkingMinimal: true,
      thinkingLow: true,
      thinkingMedium: true,
      thinkingHigh: true,
      thinkingXhigh: true,
      thinkingMax: true,
    } satisfies Record<ThemeToken, true>) as ThemeToken[];

    expect(tokens.map((token) => like.fg(token, "x"))).toEqual(tokens.map((token) => `<${token}>x`));
    expect(tokens.map((token) => stripVTControlCharacters(live.fg(token, "x")))).toEqual(
      tokens.map(() => "x"),
    );
  });

  it("paints the thinking-level tokens with pi's thinking colours", () => {
    const recording = { fg: (token: string, text: string) => `<${token}>${text}` } as unknown as Theme;
    const like = themeLike(recording);
    const levels = ["Off", "Minimal", "Low", "Medium", "High", "Xhigh", "Max"] as const;

    expect(levels.map((level) => like.fg(`thinking${level}`, "x"))).toEqual(
      levels.map((level) => `<thinking${level}>x`),
    );
  });

  it("styles inverse text through pi's theme", async () => {
    const live = await themeModule();
    const like = themeLike(live.theme);

    expect(like.inverse("x")).toBe(live.theme.inverse("x"));
  });
});

const themeModule = async () =>
  (await import(
    new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
  )) as { theme: Theme; loadThemeFromPath(path: string, mode: string): Theme };

describe("themeLike panels", () => {
  const withSuccessBg = async (value: string) => {
    const { loadThemeFromPath } = await themeModule();
    const source = new URL(
      "modes/interactive/theme/dark.json",
      import.meta.resolve("@earendil-works/pi-coding-agent"),
    );
    const json = JSON.parse(readFileSync(source, "utf8"));
    const file = join(mkdtempSync(join(tmpdir(), "pi-theme-")), "probe.json");

    writeFileSync(
      file,
      JSON.stringify({ ...json, name: "probe", colors: { ...json.colors, toolSuccessBg: value } }),
    );

    return themeLike(loadThemeFromPath(file, "truecolor"));
  };

  it("reports panels when the tool success background has a colour", async () => {
    expect((await withSuccessBg("#103010")).panels).toBe(true);
  });

  it("reports no panels when the tool success background is the terminal default", async () => {
    expect((await withSuccessBg("")).panels).toBe(false);
  });
});

describe("themeLike backgrounds", () => {
  const live = async () => {
    const module = await import(
      new URL("modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
    );

    return module.theme as Theme;
  };

  it("paints diff lines on pi's tool success and error backgrounds", () => {
    const styled: unknown[] = [];
    const recording = {
      style: (text: string, options: unknown) => {
        styled.push(options);
        return text;
      },
    } as unknown as Theme;

    themeLike(recording).bg("added", "x");
    themeLike(recording).bg("removed", "x");

    expect(styled).toEqual([{ bg: "toolSuccessBg" }, { bg: "toolErrorBg" }]);
  });

  it("paints changed words on a background mixed from the line background and the diff colour", async () => {
    const theme = await live();
    const like = themeLike(theme);
    const word = mixColors(theme.colors.toolSuccessBg, theme.colors.toolDiffAdded, 0.4);

    expect(like.bg("added", "x")).toBe(theme.style("x", { bg: "toolSuccessBg" }));
    expect(like.bg("addedWord", "x")).toBe(theme.style("x", { bg: word }));
    expect(like.bg("removedWord", "x")).not.toBe(like.bg("removed", "x"));
    expect(stripVTControlCharacters(like.bg("removedWord", "x"))).toBe("x");
  });
});

describe("themeLike text metrics", () => {
  it("measures and truncates with pi-tui", () => {
    const like = themeLike(theme);

    expect(like.width("日本")).toBe(visibleWidth("日本"));
    expect(like.width("a\tb")).toBe(visibleWidth("a\tb"));
    expect(like.width("🚀 \x1b[31mab\x1b[0m")).toBe(visibleWidth("🚀 \x1b[31mab\x1b[0m"));
    expect(like.truncate("Map the auth module", 8)).toBe("Map t...");
    expect(like.truncate("日本語テキスト", 5)).toBe("日...");
    expect(like.truncate("short", 10)).toBe("short");
    expect(like.truncate("x", 0)).toBe("");
    expect(like.truncate("Map the auth module", 12).endsWith("...")).toBe(true);
    expect(like.truncate("Map the auth module", 12)).not.toContain("…");
  });

  it("keeps pi's resets around the ellipsis of a painted line", () => {
    const painted = "\x1b[31mMap the auth module\x1b[0m";

    expect(themeLike(theme).truncate(painted, 8)).toBe(truncateToWidth(painted, 8, "..."));
  });

  it("wraps with pi-tui at word boundaries and keeps at least one column", () => {
    const like = themeLike(theme);
    const painted = "\x1b[31mMap the auth module and its callers\x1b[0m";

    expect(like.wrap("Map the auth module", 8)).toEqual(["Map the", "auth", "module"]);
    expect(like.wrap(painted, 10)).toEqual(wrapTextWithAnsi(painted, 10));
    expect(like.wrap("ab", 0)).toEqual(wrapTextWithAnsi("ab", 1));
    expect(like.wrap("", 10)).toEqual([""]);
  });
});
