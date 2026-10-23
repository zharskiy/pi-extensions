import { stripVTControlCharacters } from "node:util";
import type * as pi from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { entryHost } from "../../adapter/pi-entries.ts";

const fakeApi = () => {
  const renderers = new Map<string, pi.EntryRenderer>();
  const messages = new Map<string, pi.MessageRenderer>();
  const api = {
    registerEntryRenderer: (type: string, renderer: pi.EntryRenderer) => {
      renderers.set(type, renderer);
    },
    registerMessageRenderer: (type: string, renderer: pi.MessageRenderer) => {
      messages.set(type, renderer);
    },
  } as unknown as Pick<pi.ExtensionAPI, "registerEntryRenderer" | "registerMessageRenderer">;

  return { api, renderers, messages };
};

describe("entryHost", () => {
  it("registers an entry renderer that passes pi's data, expanded flag and theme and cuts lines to the width after the pad", () => {
    const { api, renderers } = fakeApi();
    const seen: unknown[] = [];
    const theme = { fg: (token: string, text: string) => `${token}:${text}`, bold: (text: string) => text };

    entryHost(api, () => 1).registerEntryRenderer("x:entry", (data, width, expanded, themed) => {
      seen.push({ data, width, expanded });
      return [themed.fg("keyword", "0123456789"), "ok"];
    });

    const component = renderers.get("x:entry")?.(
      { type: "custom", customType: "x:entry", data: { a: 1 }, id: "e", parentId: null, timestamp: "" },
      { expanded: true },
      theme as unknown as pi.Theme,
    );

    expect(component?.render(12).map((line) => stripVTControlCharacters(line))).toEqual([
      " syntaxKeyw…",
      " ok",
    ]);
    expect(seen).toEqual([{ data: { a: 1 }, width: 11, expanded: true }]);
  });

  it("registers a message renderer that gets the message text and details inside pi's output pad", () => {
    const { api, messages } = fakeApi();
    const seen: unknown[] = [];
    const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };

    entryHost(api).registerMessageRenderer("x:message", (message, width, expanded) => {
      seen.push({ message, width, expanded });
      return ["● Handoff", "x".repeat(40)];
    });

    const render = (outputPad: number) =>
      messages
        .get("x:message")?.(
          {
            role: "custom",
            customType: "x:message",
            content: [{ type: "text", text: "seed" }],
            details: { a: 1 },
            display: true,
            timestamp: 0,
          },
          { expanded: false, outputPad },
          theme as unknown as pi.Theme,
        )
        ?.render(12)
        .map((line) => stripVTControlCharacters(line));

    expect(render(1)).toEqual([" ● Handoff", ` ${"x".repeat(10)}…`]);
    expect(render(0)).toEqual(["● Handoff", `${"x".repeat(11)}…`]);
    expect(seen[0]).toEqual({ message: { text: "seed", details: { a: 1 } }, width: 11, expanded: false });
  });
});
