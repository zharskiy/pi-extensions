import { describe, expect, it } from "vitest";
import { isSession, roleOf } from "../../backend/index.ts";

const MANAGED = { "pinata.managed": "true" };

const withRole = (role: string) => ({ ...MANAGED, "pinata.role": role });

describe("container roles", () => {
  it("reads the role a container is labelled with", () => {
    expect(["agent", "relay", "pod", "service"].map((role) => roleOf(withRole(role)))).toEqual([
      "agent",
      "relay",
      "pod",
      "service",
    ]);
  });

  it("gives a managed container without a role label no role", () => {
    expect(roleOf(MANAGED)).toBeUndefined();
  });

  it("counts only an agent as a session, and no container without a role", () => {
    expect(["agent", "relay", "pod", "service"].filter((role) => isSession(withRole(role)))).toEqual([
      "agent",
    ]);
    expect(isSession(MANAGED)).toBe(false);
  });

  it("tells the relay apart from the other roles", () => {
    expect(["agent", "relay", "pod", "service"].filter((role) => roleOf(withRole(role)) !== "relay")).toEqual(
      ["agent", "pod", "service"],
    );
  });
});
