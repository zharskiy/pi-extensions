import type { ToolSpec } from "../../../../../pi-adapter/index.ts";
import type { Plugin } from "../../model/plugin.ts";
import type { Settings } from "../../model/settings.ts";
import { type FetchedPage, fetchPage } from "./fetch.ts";

type FetchParams = { url: string };

const DESCRIPTION =
  "Fetch a web page over http or https and return its readable text with the final URL, status and title. Long pages are cut and say how much was shown.";

const pageText = (page: FetchedPage, maxBytes: number) => {
  const cut = page.chars.shown < page.chars.total;

  const lines = [
    `URL: ${page.url}`,
    `Status: ${page.status} ${page.reason}`.trimEnd(),
    `Title: ${page.title ?? "none"}`,
    `Fetched: ${new Date().toISOString()}`,
    ...(cut ? [`Truncated: ${page.chars.shown} of ${page.chars.total} chars`] : []),
    ...(page.bytesCut ? [`Truncated: body cut at ${maxBytes} bytes`] : []),
  ];

  return `${lines.join("\n")}\n\n${page.text}`;
};

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const fetchSpec = (settings: Settings): ToolSpec<FetchParams> => ({
  name: "fetch",
  label: "Fetch",
  description: DESCRIPTION,
  promptSnippet: "read a web page by URL",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The http or https URL to fetch." } },
    required: ["url"],
    additionalProperties: false,
  },
  executionMode: "parallel",
  execute: async ({ url }, { signal }) => {
    const limits = {
      timeoutSeconds: settings.fetchTimeoutSeconds,
      maxBytes: settings.fetchMaxBytes,
      maxChars: settings.fetchMaxChars,
    };

    try {
      return { text: pageText(await fetchPage(url, limits, signal), limits.maxBytes) };
    } catch (error) {
      return { text: `Fetch failed: ${url}: ${reasonOf(error)}`, isError: true };
    }
  },
});

export const fetchToolPlugin: Plugin = {
  id: "fetch-tool",
  requires: [],
  enable: ({ services, settings }) => {
    services.provide("fetchTool", { tool: () => fetchSpec(settings) });
  },
};
