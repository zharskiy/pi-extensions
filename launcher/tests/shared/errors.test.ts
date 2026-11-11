import { describe, expect, it } from "vitest";
import { errorMessage, isSecretName, LauncherError } from "../../shared/index.ts";

describe("LauncherError", () => {
  it("carries the message and the hint", () => {
    const error = new LauncherError("colima is not running", "run colima start");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LauncherError");
    expect(error.message).toBe("colima is not running");
    expect(error.hint).toBe("run colima start");
  });

  it("leaves the hint out when none is given", () => {
    expect(new LauncherError("no backend").hint).toBeUndefined();
  });
});

describe("errorMessage", () => {
  it("reads an error's message and stringifies anything else", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
  });
});

describe("isSecretName", () => {
  it("flags names that look like secrets in any case", () => {
    expect(isSecretName("GATEWAY_API_KEY")).toBe(true);
    expect(isSecretName("session_token")).toBe(true);
    expect(isSecretName("TERM")).toBe(false);
  });
});
