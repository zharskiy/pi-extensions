import { describe, expect, it } from "vitest";
import { createFakeHost } from "../../../core/test/helpers/fakes.ts";
import { createComposer } from "../src/composer.ts";

describe("composer", () => {
  it("frames the editor on session start", () => {
    const host = createFakeHost();

    createComposer(host);

    expect(host.editorFrame).toBeUndefined();

    host.start();

    expect(host.editorFrame?.decorate(["──", "ab", "──"], (text) => text)).toHaveLength(3);
  });

  it("leaves an editor another extension set alone", () => {
    const host = createFakeHost();

    host.foreignEditor = true;
    createComposer(host);
    host.start();

    expect(host.editorFrame).toBeUndefined();
  });

  it("uses the given chevron", () => {
    const host = createFakeHost();

    createComposer(host, ">");
    host.start();

    expect(host.editorFrame?.decorate(["──", "ab", "──"], (text) => text)[1]).toContain(">");
  });
});
