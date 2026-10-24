import { describe, expect, it } from "vitest";
import { createFakeHost, plainTheme } from "../../../test/framework/index.ts";
import { createComposer } from "../api/plugin.ts";
import { CHEVRON } from "../ui/frame.ts";

const layout = { bottom: 2, scrolled: false };
const plain = (text: string) => text;

describe("composer", () => {
  it("sets the frame on session start", () => {
    const host = createFakeHost();

    createComposer(host);

    expect(host.editorFrame).toBeUndefined();

    host.start();

    const prompt = host.editorFrame?.decorate(["──", "ab", "──"], layout, plain, plainTheme)[1] ?? "";

    expect(prompt).toBe(` ${CHEVRON} ab`);
  });
});
