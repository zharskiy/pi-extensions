import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createWorkingUi } from "../../adapter/pi-working.ts";

const fakeCtx = () => {
  const indicators: unknown[] = [];
  const messages: (string | undefined)[] = [];

  const ctx = {
    ui: {
      theme: { fg: (token: string, text: string) => `<${token}>${text}` },
      setWorkingIndicator: (options?: unknown) => {
        indicators.push(options);
      },
      setWorkingMessage: (message?: string) => {
        messages.push(message);
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, indicators, messages };
};

describe("createWorkingUi", () => {
  it("paints the frames in the accent colour", () => {
    const { ctx, indicators } = fakeCtx();

    createWorkingUi(() => ctx).setWorkingIndicator({ frames: ["a", "b"], intervalMs: 80 });

    expect(indicators).toEqual([{ frames: ["<accent>a", "<accent>b"], intervalMs: 80 }]);
  });

  it("restores the default indicator and message", () => {
    const { ctx, indicators, messages } = fakeCtx();
    const ui = createWorkingUi(() => ctx);

    ui.setWorkingIndicator(undefined);
    ui.setWorkingMessage("Musing");
    ui.setWorkingMessage(undefined);

    expect(indicators).toEqual([undefined]);
    expect(messages).toEqual(["Musing", undefined]);
  });

  it("does nothing outside tui mode", () => {
    const ui = createWorkingUi(() => undefined);

    expect(() => {
      ui.setWorkingIndicator({ frames: ["a"], intervalMs: 80 });
      ui.setWorkingMessage("Musing");
    }).not.toThrow();
  });
});
