import { describe, expect, it } from "vitest";
import { footerText } from "../ui/footer-text.ts";

describe("footer", () => {
  it("formats costs in dollars with two decimals and rounds the raw total", () => {
    const text = footerText({
      main: 0.1234,
      sources: [{ source: "agents", cost: 0.0534 }],
      subscription: false,
    });

    expect(text).toBe("main $0.12 · agents $0.05 · total $0.18");
  });

  it("shows main, the source and the total", () => {
    expect(footerText({ main: 0.5, sources: [{ source: "agents", cost: 0.25 }], subscription: false })).toBe(
      "main $0.50 · agents $0.25 · total $0.75",
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

    expect(text).toBe("main $1.00 · agents $0.50 · jobs $0.25 · total $1.75 (sub)");
  });

  it("shows a zero main cost and marks sub-cent costs", () => {
    expect(footerText({ main: 0, sources: [{ source: "agents", cost: 0.004 }], subscription: false })).toBe(
      "main $0.00 · agents <$0.01 · total <$0.01",
    );
  });

  it("is hidden until a source spent something", () => {
    expect(footerText({ main: 1, sources: [], subscription: false })).toBeUndefined();
    expect(
      footerText({ main: 1, sources: [{ source: "agents", cost: 0 }], subscription: false }),
    ).toBeUndefined();
  });
});
