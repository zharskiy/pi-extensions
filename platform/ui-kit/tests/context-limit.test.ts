import { describe, expect, it } from "vitest";
import { tokenTaggingTheme } from "../../../test/framework/index.ts";
import { limitLevel } from "../../shared/index.ts";
import { handoffNotice, limitFigure, limitLine, limitTail } from "../context-limit.ts";

const theme = tokenTaggingTheme({ bold: true });

const limit = { request: 100_000, warn: 80_000 };

const level = (tokens: number) => limitLevel(tokens, limit);

describe("working context", () => {
  it("paints the figure in text, warning at the soft level and bold error at the request", () => {
    expect(limitFigure(theme, level(50_000), 50_000)).toBe("<text>50.0k</>");
    expect(limitFigure(theme, level(85_000), 85_000)).toBe("<warning>85.0k</>");
    expect(limitFigure(theme, level(100_500), 100_500)).toBe("<b><error>100.5k</></b>");
  });

  it("paints the tail dim below the soft level and in the figure's tone from it", () => {
    expect(limitTail(theme, level(50_000), 100_000)).toBe("<dim>of 100k</>");
    expect(limitTail(theme, level(85_000), 100_000)).toBe("<warning>of 100k</>");
    expect(limitTail(theme, undefined, 175_000)).toBe("<dim>of 175k</>");
  });

  it("paints the whole phrase with a dim label", () => {
    expect(limitLine(theme, level(100_500), 100_500, 100_000)).toBe(
      "<dim>working context</> <b><error>100.5k</></b> <error>of 100k</>",
    );
  });
});

describe("handoff notice", () => {
  it("names the handoff point and the tokens used, in the warning colour, from the soft level on", () => {
    expect(handoffNotice(level(142_300), 142_300, 100_000)).toEqual({
      token: "warning",
      text: "» handoff at 100k tokens · 142.3k used",
    });
    expect(handoffNotice(level(85_000), 85_000, 100_000)?.text).toBe("» handoff at 100k tokens · 85.0k used");
    expect(handoffNotice(level(50_000), 50_000, 100_000)).toBeUndefined();
  });
});
