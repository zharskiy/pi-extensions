import { describe, expect, it } from "vitest";
import { tokenTaggingTheme } from "../../../test/framework/index.ts";
import { limitLevel } from "../../shared/index.ts";
import { handoffNotice, limitFigure, limitTail, limitTone, showsHandoffNotice } from "../limit-tone.ts";

const theme = tokenTaggingTheme({ bold: true });

const limit = { request: 100_000, warn: 80_000 };

describe("limit tone", () => {
  it("is plain below the soft level, warning at it and error at the request", () => {
    expect(limitTone(limitLevel(50_000, limit))).toBeUndefined();
    expect(limitTone(limitLevel(80_000, limit))).toBe("warning");
    expect(limitTone(limitLevel(100_000, limit))).toBe("error");
    expect(limitTone(undefined)).toBeUndefined();
  });

  it("paints the figure in text, warning or bold error and the tail in dim or the same tone", () => {
    expect(limitFigure(theme, "normal", "50.0k")).toBe("<text>50.0k</>");
    expect(limitFigure(theme, "soft", "85.0k")).toBe("<warning>85.0k</>");
    expect(limitFigure(theme, "hard", "100.5k")).toBe("<b><error>100.5k</></b>");
    expect(limitTail(theme, "normal", 100_000)).toBe("<dim>of 100k</>");
    expect(limitTail(theme, "soft", 100_000)).toBe("<warning>of 100k</>");
    expect(limitTail(theme, "hard", 175_000)).toBe("<error>of 175k</>");
  });
});

describe("handoff notice", () => {
  it("shows at the soft level and at the request only", () => {
    expect(["unknown", "normal", "soft", "hard"].map((level) => showsHandoffNotice(level as never))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  it("names the handoff point and the tokens used, in the warning colour", () => {
    expect(handoffNotice(142_300, 175_000)).toEqual({
      token: "warning",
      text: "» handoff at 175k tokens · 142.3k used",
    });
  });
});
