import { describe, expect, it } from "vitest";
import type { SpendingTotals } from "../../../platform/shared/index.ts";
import { footerText } from "../ui/footer-text.ts";

const totals = (
  main: number,
  sources: { source: string; cost: number }[],
  subscription = false,
): SpendingTotals => ({
  main: { cost: main, tokens: 0 },
  sources: sources.map((entry) => ({ ...entry, tokens: 0 })),
  subscription,
});

describe("footer", () => {
  it("formats costs in dollars with two decimals and rounds the raw total", () => {
    const text = footerText(totals(0.1234, [{ source: "agents", cost: 0.0534 }]));

    expect(text).toBe("main $0.12 · agents $0.05 · total $0.18");
  });

  it("shows main, the source and the total", () => {
    expect(footerText(totals(0.5, [{ source: "agents", cost: 0.25 }]))).toBe(
      "main $0.50 · agents $0.25 · total $0.75",
    );
  });

  it("lists every source and marks subscription sessions", () => {
    const text = footerText(
      totals(
        1,
        [
          { source: "agents", cost: 0.5 },
          { source: "jobs", cost: 0.25 },
        ],
        true,
      ),
    );

    expect(text).toBe("main $1.00 · agents $0.50 · jobs $0.25 · total $1.75 (sub)");
  });

  it("shows a zero main cost and marks sub-cent costs", () => {
    expect(footerText(totals(0, [{ source: "agents", cost: 0.004 }]))).toBe(
      "main $0.00 · agents <$0.01 · total <$0.01",
    );
  });

  it("is hidden until a source spent something", () => {
    expect(footerText(totals(1, []))).toBeUndefined();
    expect(footerText(totals(1, [{ source: "agents", cost: 0 }]))).toBeUndefined();
  });
});
