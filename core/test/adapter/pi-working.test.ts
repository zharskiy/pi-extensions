import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createWorkingUi } from "../../../pi-adapter/ui/pi-working.ts";

const fakeCtx = () => {
  const messages: (string | undefined)[] = [];
  const visibility: boolean[] = [];

  const ctx = {
    ui: {
      setWorkingMessage: (message?: string) => {
        messages.push(message);
      },
      setWorkingVisible: (visible: boolean) => {
        visibility.push(visible);
      },
    },
  } as unknown as ExtensionContext;

  return { ctx, messages, visibility };
};

describe("createWorkingUi", () => {
  it("sets and restores the message", () => {
    const { ctx, messages } = fakeCtx();
    const ui = createWorkingUi(() => ctx);

    ui.setWorkingMessage("Running");
    ui.setWorkingMessage(undefined);

    expect(messages).toEqual(["Running", undefined]);
  });

  it("forwards setWorkingVisible in tui only", () => {
    const { ctx, visibility } = fakeCtx();
    let tui = true;
    const ui = createWorkingUi(() => (tui ? ctx : undefined));

    ui.setWorkingVisible(false);
    ui.setWorkingVisible(true);
    tui = false;
    ui.setWorkingVisible(false);

    expect(visibility).toEqual([false, true]);
  });

  it("does nothing outside tui mode", () => {
    const ui = createWorkingUi(() => undefined);

    expect(() => {
      ui.setWorkingMessage("Running");
      ui.setWorkingVisible(false);
    }).not.toThrow();
  });
});
