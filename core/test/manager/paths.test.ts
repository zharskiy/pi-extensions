import { describe, expect, it } from "vitest";
import { sessionDataDir } from "../../manager/paths.ts";
import { createFakeHost } from "../helpers/fakes.ts";

describe("sessionDataDir", () => {
  it("sits next to the session file, or under pi's agent dir without one", () => {
    const info = { ...createFakeHost().info, id: "s1", agentDir: "/agent" };

    expect(sessionDataDir({ ...info, file: "/sessions/s1.jsonl" }, "ns")).toBe("/sessions/s1");
    expect(sessionDataDir({ ...info, file: undefined }, "ns")).toBe("/agent/ns/s1");
  });
});
