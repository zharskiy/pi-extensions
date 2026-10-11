import { describe, expect, it } from "vitest";
import { footerText, formatCost, isVisible } from "../src/footer.ts";

describe("footer", () => {
  it("formats costs in dollars with three decimals", () => {
    expect(formatCost(0.1234)).toBe("$0.123");
  });

  it("shows main, the source and the total", () => {
    expect(footerText({ main: 0.5, sources: [{ source: "agents", cost: 0.25 }], subscription: false })).toBe(
      "main $0.500 · agents $0.250 · total $0.750",
    );
  });

  it("lists every source and marks subscription sessions", () => {
    const text = footerText({
      main: 1,
      sources: [
        { source: "agents", cost: 0.5 },
        { source: "jobs", cost: 0.25 },
      ],
      subscription: true,
    });

    expect(text).toBe("main $1.000 · agents $0.500 · jobs $0.250 · total $1.750 (sub)");
  });

  it("is visible only once a source spent something", () => {
    expect(isVisible([])).toBe(false);
    expect(isVisible([{ source: "agents", cost: 0 }])).toBe(false);
    expect(isVisible([{ source: "agents", cost: 0.01 }])).toBe(true);
  });
});
