import { join } from "node:path";
import { type IniSection, iniWords, parseIni } from "../../shared/index.ts";
import { hasUrlUserinfo } from "../endpoints.ts";
import { mergeSections, noticeOnly, type Section } from "../rules.ts";
import type { ToolsInput } from "../types.ts";
import { firstExisting, sandboxedConfigNotice, type UrlSecret, urlCredentialSection } from "./files.ts";

const INDEX_KEYS = new Set(["index-url", "extra-index-url"]);

const GLOBAL = "global";

const homePaths = (input: ToolsInput) => [
  join(input.home, ".config", "pip", "pip.conf"),
  join(input.home, "Library", "Application Support", "pip", "pip.conf"),
  join(input.home, ".pip", "pip.conf"),
];

const configPaths = async (input: ToolsInput): Promise<Section<string[]>> => {
  const file = input.env.PIP_CONFIG_FILE;

  if (!file) {
    return noticeOnly(homePaths(input));
  }

  const notice = await sandboxedConfigNotice(input, "pip", "PIP_CONFIG_FILE", file);

  return notice === undefined
    ? noticeOnly([file, ...homePaths(input)])
    : noticeOnly(homePaths(input), notice);
};

const pipName = (name: string) => name.toLowerCase().replaceAll("_", "-").replace(/^--/, "");

const PROXY_KEY = "proxy";

const urlSection = (input: ToolsInput, key: string, url: string, secret: UrlSecret) =>
  urlCredentialSection(input, { label: "pip", key, identity: `pip:${key}`, url, secret });

const dropped = (key: string, reason: string) =>
  noticeOnly<Array<[string, string]>>([], `pip: ${key} ${reason}`);

const entrySection = (
  input: ToolsInput,
  file: string,
  section: string,
  [name, value]: [string, string],
): Section<Array<[string, string]>> => {
  const key = `${section}.${name}`;
  const normalized = pipName(name);

  if (normalized === PROXY_KEY) {
    return dropped(key, "stays on the host; the sandbox reaches the network through the launcher proxy");
  }

  if (!INDEX_KEYS.has(normalized)) {
    return iniWords(value).some(hasUrlUserinfo)
      ? dropped(key, "carries credentials in a URL and stays on the host")
      : { value: [[name, value]], rules: [], notices: [] };
  }

  const words = mergeSections(
    iniWords(value).map((word, index) =>
      urlSection(input, `${key}[${index}]`, word, { file, format: "ini", key: `${key}[${index}]` }),
    ),
  );

  return { value: [[name, words.values.join("\n")]], rules: words.rules, notices: words.notices };
};

const sectionOf = (input: ToolsInput, file: string, section: IniSection): Section<IniSection> => {
  const merged = mergeSections(
    section.entries.map((entry) => entrySection(input, file, section.name, entry)),
  );

  return {
    value: { name: section.name, entries: merged.values.flat() },
    rules: merged.rules,
    notices: merged.notices,
  };
};

const withEnvIndex = (input: ToolsInput, sections: IniSection[]): Section<IniSection[]> => {
  const url = input.env.PIP_INDEX_URL;

  if (url === undefined || url === "") {
    return { value: sections, rules: [], notices: [] };
  }

  const index = urlSection(input, "env.PIP_INDEX_URL", url, { env: "PIP_INDEX_URL" });
  const others = sections.filter((section) => section.name !== GLOBAL);
  const global = sections.find((section) => section.name === GLOBAL)?.entries ?? [];
  const entries: Array<[string, string]> = [
    ...global.filter(([name]) => name !== "index-url"),
    ["index-url", index.value],
  ];

  return { value: [{ name: GLOBAL, entries }, ...others], rules: index.rules, notices: index.notices };
};

export const derivePip = async (input: ToolsInput): Promise<Section<IniSection[] | undefined>> => {
  const paths = await configPaths(input);
  const config = await firstExisting(paths.value);

  if (config === undefined && !input.env.PIP_INDEX_URL) {
    return noticeOnly(undefined, ...paths.notices);
  }

  const file = config?.path ?? "";
  const sections = mergeSections(
    parseIni(config?.text ?? "").map((section) => sectionOf(input, file, section)),
  );
  const indexed = withEnvIndex(input, sections.values);

  return {
    value: indexed.value,
    rules: [...sections.rules, ...indexed.rules],
    notices: [...paths.notices, ...sections.notices, ...indexed.notices],
  };
};
