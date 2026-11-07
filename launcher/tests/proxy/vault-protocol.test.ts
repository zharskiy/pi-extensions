import { describe, expect, it } from "vitest";
import { codePlaceholder, isCodePlaceholder } from "../../proxy/vault/protocol.ts";
import { isPlaceholder, vaultPlaceholders } from "../../shared/index.ts";

describe("code placeholders", () => {
  it("mints a fresh code placeholder each time in its own format", () => {
    const code = codePlaceholder();

    expect(code).toMatch(/^pi-sandbox-code-[0-9a-f]{32}$/);

    expect(codePlaceholder()).not.toBe(code);

    expect(isPlaceholder(code)).toBe(true);

    expect(isCodePlaceholder(code)).toBe(true);

    expect(isCodePlaceholder(vaultPlaceholders("salt", "docs").access)).toBe(false);
  });
});
