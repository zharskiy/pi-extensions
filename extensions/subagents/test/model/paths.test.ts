import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionDataDir } from "../../../../core/manager/paths.ts";
import { agentsDirFor, NAMESPACE } from "../../src/model/paths.ts";

describe("agentsDirFor", () => {
  it("keeps the agents level without a session", () => {
    expect(agentsDirFor(undefined)).toBe(join(sessionDataDir(undefined, NAMESPACE), "agents"));
  });
});
