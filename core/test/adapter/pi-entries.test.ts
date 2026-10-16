import { stripVTControlCharacters } from "node:util";
import type * as pi from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { entryHost } from "../../adapter/pi-entries.ts";

const fakeApi = () => {
  const renderers = new Map<string, pi.EntryRenderer>();
  const api = {
    registerEntryRenderer: (type: string, renderer: pi.EntryRenderer) => {
      renderers.set(type, renderer);
    },
  } as unknown as Pick<pi.ExtensionAPI, "registerEntryRenderer">;

  return { api, renderers };
};

describe("entryHost", () => {
  it("registers an entry renderer that passes pi's data, expanded flag and theme and cuts lines to the width", () => {
    const { api, renderers } = fakeApi();
    const seen: unknown[] = [];
    const theme = { fg: (token: string, text: string) => `${token}:${text}`, bold: (text: string) => text };

    entryHost(api).registerEntryRenderer("x:entry", (data, width, expanded, themed) => {
      seen.push({ data, width, expanded });
      return [themed.fg("keyword", "0123456789"), "ok"];
    });

    const component = renderers.get("x:entry")?.(
      { type: "custom", customType: "x:entry", data: { a: 1 }, id: "e", parentId: null, timestamp: "" },
      { expanded: true },
      theme as unknown as pi.Theme,
    );

    expect(component?.render(12).map((line) => stripVTControlCharacters(line))).toEqual([
      "syntaxKeywo…",
      "ok",
    ]);
    expect(seen).toEqual([{ data: { a: 1 }, width: 12, expanded: true }]);
  });
});
