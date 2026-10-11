import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sessionDataDir } from "../../manager/paths.ts";
import { createFakeHost } from "../helpers/fakes.ts";

describe("sessionDataDir", () => {
  it("sits next to the session file, or under the namespace in tmpdir without one", () => {
    const info = createFakeHost().info;

    expect(sessionDataDir({ ...info, file: "/sessions/s1.jsonl" }, "ns")).toBe("/sessions/s1");
    expect(sessionDataDir({ ...info, id: "s2", file: undefined }, "ns")).toBe(join(tmpdir(), "ns", "s2"));
    expect(sessionDataDir(undefined, "ns")).toBe(join(tmpdir(), "ns", "no-session"));
  });
});
