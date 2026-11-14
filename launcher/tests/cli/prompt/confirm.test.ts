import { describe, expect, it } from "vitest";
import { BACK } from "../../../cli/prompt/types.ts";
import { KEY, outcome, pause, press, richPrompts } from "./fake-tty.ts";

const HOME = {
  title: "Share your whole home with the sandbox VM instead?",
  detail: ["With no project folder, pi starts in any folder."],
  yes: "Yes, share ~",
  no: "No, choose folders",
  initial: false,
};

describe("confirm", () => {
  it("lists the default option first with the pointer on it", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.confirm(HOME);

    await pause();

    expect(screen.lines()).toEqual([
      "◆  Share your whole home with the sandbox VM instead?",
      "│  With no project folder, pi starts in any folder.",
      "│",
      "│  › No, choose folders     Yes, share ~",
      "│",
      "│  ←→ choose · y/n · enter confirm · esc back · ctrl-c cancel",
    ]);

    await press(input, KEY.enter);

    expect(await reply).toBe(false);
  });

  it("toggles with the arrows, Tab, h and l, then submits the pointed option", async () => {
    const { prompts, screen, input } = richPrompts();
    const reply = prompts.confirm(HOME);

    await press(input, KEY.right);

    expect(screen.lines()).toContain("│    No, choose folders   › Yes, share ~");

    await press(input, KEY.left, KEY.tab, "h", "l", KEY.enter);

    expect(await reply).toBe(true);
  });

  it("submits at once on y or n and collapses to the label", async () => {
    const yes = richPrompts();
    const first = yes.prompts.confirm(HOME);

    await press(yes.input, "Y");

    expect(await first).toBe(true);

    expect(yes.screen.lines()).toEqual([
      "◇  Share your whole home with the sandbox VM instead?",
      "│  Yes, share ~",
      "│",
    ]);

    const no = richPrompts();
    const second = no.prompts.confirm({ ...HOME, initial: true });

    await press(no.input, "n");

    expect(await second).toBe(false);
  });

  it("returns BACK on Esc and Cancelled end on ctrl-d", async () => {
    const escaped = richPrompts();
    const first = escaped.prompts.confirm(HOME);

    await press(escaped.input, KEY.escape);

    expect(await first).toBe(BACK);

    const ended = richPrompts();
    const second = outcome(ended.prompts.confirm(HOME));

    await press(ended.input, KEY.ctrlD);

    expect((await second).error).toMatchObject({ cause: "end" });
  });
});
