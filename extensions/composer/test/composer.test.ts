import { describe, expect, it } from "vitest";
import { createFakeHost, plainTheme } from "../../../core/test/helpers/fakes.ts";
import { createComposer } from "../src/composer.ts";
import { CHEVRON } from "../src/frame.ts";

const layout = { bottom: 2, scrolled: false };
const ESC = String.fromCharCode(27);
const plain = (text: string) => text;

describe("composer", () => {
  it("sets the frame on session start", () => {
    const host = createFakeHost();

    createComposer(host);

    expect(host.editorFrame).toBeUndefined();

    host.start();

    const prompt = host.editorFrame?.decorate(["──", "ab", "──"], layout, plain, plainTheme)[1] ?? "";

    expect(prompt.startsWith(` ${ESC}[1m`)).toBe(true);
    expect(prompt).toContain(CHEVRON);
  });
});
