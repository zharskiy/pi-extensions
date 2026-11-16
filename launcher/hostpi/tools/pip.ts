import { join } from "node:path";
import { hasUrlUserinfo, type IniSection, iniWords, parseIni } from "../../shared/index.ts";
import { mergeSections, noticeOnly, type Section } from "../rules.ts";
import type { Registry, ToolsInput } from "../types.ts";
import {
  firstExisting,
  PROXY_KEY_REASON,
  registriesOf,
  URL_CREDENTIAL_REASON,
  type UrlSecret,
  urlCredentialSection,
} from "./files.ts";

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
    return dropped(key, PROXY_KEY_REASON);
  }

  if (!INDEX_KEYS.has(normalized)) {
    return iniWords(value).some(hasUrlUserinfo)
      ? dropped(key, URL_CREDENTIAL_REASON)
      : noticeOnly([[name, value]]);
  }

  const words = mergeSections(
    iniWords(value).map((word, index) =>
      urlSection(input, `${key}[${index}]`, word, { file, format: "ini", key: `${key}[${index}]` }),
    ),
  );

  return { ...words, value: [[name, words.value.join("\n")]] };
};

const sectionOf = (input: ToolsInput, file: string, section: IniSection): Section<IniSection> => {
  const merged = mergeSections(
    section.entries.map((entry) => entrySection(input, file, section.name, entry)),
  );

  return { ...merged, value: { name: section.name, entries: merged.value.flat() } };
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
    ...sections,
    registries: registriesOf("pip", indexUrls(sections.value)),
  };
};
