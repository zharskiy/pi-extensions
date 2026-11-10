import { join } from "node:path";
import { hasUrlUserinfo, type IniSection, iniWords, parseIni } from "../../shared/index.ts";
import { mergeSections, noticeOnly, type Section } from "../rules.ts";
import type { ToolsInput } from "../types.ts";
import { firstExisting, type Registry, registriesOf, type UrlSecret, urlCredentialSection } from "./files.ts";

const INDEX_KEYS = new Set(["index-url", "extra-index-url"]);

const homePaths = (input: ToolsInput) => [
  join(input.home, ".config", "pip", "pip.conf"),
  join(input.home, "Library", "Application Support", "pip", "pip.conf"),
  join(input.home, ".pip", "pip.conf"),
];

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

const indexUrls = (sections: IniSection[]) =>
  sections.flatMap((section) =>
    section.entries.flatMap(([name, value]) => (INDEX_KEYS.has(pipName(name)) ? iniWords(value) : [])),
  );

export const derivePip = async (
  input: ToolsInput,
): Promise<Section<IniSection[] | undefined> & { registries: Registry[] }> => {
  const config = await firstExisting(homePaths(input));

  if (config === undefined) {
    return { ...noticeOnly(undefined), registries: [] };
  }

  const sections = mergeSections(
    parseIni(config.text).map((section) => sectionOf(input, config.path, section)),
  );

  return {
    value: sections.values,
    rules: sections.rules,
    notices: sections.notices,
    registries: registriesOf("pip", indexUrls(sections.values)),
  };
};
