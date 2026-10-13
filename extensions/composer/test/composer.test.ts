import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
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

    expect(host.editorFrame?.decorate(["──", "ab", "──"], layout, plain)[1]?.startsWith(` ${ESC}[1m`)).toBe(
      true,
    );
  });

  it("leaves an editor another extension set alone", () => {
    const host = createFakeHost();

    host.foreignEditor = true;
    createComposer(host);
    host.start();

    expect(host.editorFrame).toBeUndefined();
  });

  it("uses the chevron constant", () => {
    const host = createFakeHost();

    createComposer(host);
    host.start();

    expect(host.editorFrame?.decorate(["──", "ab", "──"], layout, plain)[1]).toContain(CHEVRON);
  });
});
