import { describe, expect, it } from "vitest";
import {
  agentLimit,
  effectiveContextLimit,
  limitStep,
  type StepLimit,
} from "../../core/model/context-limit.ts";

describe("effective context limit", () => {
  it("uses the declared limit unless the model window minus the reserve is smaller", () => {
    expect(effectiveContextLimit(100_000, 400_000, 16_384)).toBe(100_000);
    expect(effectiveContextLimit(100_000, 64_000, 16_384)).toBe(47_616);
    expect(effectiveContextLimit(300_000, 200_000, 16_000)).toBe(184_000);
  });

  it("keeps the declared limit when the model window is unknown", () => {
    expect(effectiveContextLimit(100_000, 0, 16_000)).toBe(100_000);
  });
});

describe("agent limit", () => {
  const settings = { reserveTokens: 16_000, softContextRatio: 0.8, hardContextRatio: 1.15 };

  it("requests at the effective limit, warns at the soft ratio and aborts past the hard ratio", () => {
    const limit = agentLimit(100_000, 400_000, settings);

    expect(limit).toMatchObject({ request: 100_000, warn: 80_000 });
    expect(limit.ceiling).toBeCloseTo(115_000);
  });

  it("caps the request by the window minus the reserve", () => {
    expect(agentLimit(300_000, 200_000, settings).request).toBe(184_000);
  });
});

const agent: StepLimit = {
  request: 100_000,
  warn: 80_000,
  ceiling: 115_000,
  graceTurns: 2,
  maxTurnsAfterRequest: 3,
};

const fresh = { requested: false, turnsSinceRequest: 0 };

const requestedFor = (turnsSinceRequest: number) => ({ requested: true, turnsSinceRequest });

describe("limit step before the request", () => {
  it("requests at the request line and does nothing below it, soft level included", () => {
    expect(limitStep(79_999, agent, fresh)).toBe("none");
    expect(limitStep(85_000, agent, fresh)).toBe("none");
    expect(limitStep(99_999, agent, fresh)).toBe("none");
    expect(limitStep(100_000, agent, fresh)).toBe("request");
  });
});

describe("limit step after the request", () => {
  it("waits out the grace turns before the ceiling aborts", () => {
    expect(limitStep(150_000, agent, requestedFor(0))).toBe("none");
    expect(limitStep(150_000, agent, requestedFor(1))).toBe("none");
    expect(limitStep(115_000, agent, requestedFor(2))).toBe("abort");
  });

  it("aborts after the turn cap even under the ceiling", () => {
    expect(limitStep(101_000, agent, requestedFor(2))).toBe("none");
    expect(limitStep(101_000, agent, requestedFor(3))).toBe("abort");
  });
});
