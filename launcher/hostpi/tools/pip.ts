import { join } from "node:path";
import type { SecretRef } from "../../config/index.ts";
import { type IniSection, iniWords, parseIni } from "../../shared/index.ts";
import { endpointOf } from "../endpoints.ts";
import { mergeSections, type Section } from "../rules.ts";
import type { ToolsInput } from "../types.ts";
import { emptySection, firstExisting, placeholderRules, toolPlaceholder } from "./files.ts";

const INDEX_KEYS = new Set(["index-url", "extra-index-url"]);

const GLOBAL = "global";

const configPaths = (input: ToolsInput) => [
  join(input.home, ".config", "pip", "pip.conf"),
  join(input.home, "Library", "Application Support", "pip", "pip.conf"),
];

const withPassword = (url: string, placeholder: string) => {
  const parsed = new URL(url);

  parsed.password = placeholder;

  return parsed.href;
};

const hasPassword = (word: string) => URL.canParse(word) && new URL(word).password !== "";

const urlSection = (input: ToolsInput, key: string, url: string, secret: SecretRef): Section<string> => {
  if (!hasPassword(url)) {
    return { value: url, rules: [], notices: [] };
  }

  const identity = `pip:${key}`;
  const placeholder = toolPlaceholder(input, identity);
  const result = endpointOf(url);

  if (!("endpoint" in result)) {
    return {
      value: withPassword(url, ""),
      rules: [],
      notices: [`pip: ${key} is not an https URL; its password stays on the host`],
    };
  }

  return {
    value: withPassword(url, placeholder),
    rules: placeholderRules(identity, [result.endpoint], placeholder, secret),
    notices: [],
  };
};

const entrySection = (
  input: ToolsInput,
  file: string,
  section: string,
  [name, value]: [string, string],
): Section<[string, string]> => {
  if (!INDEX_KEYS.has(name)) {
    return { value: [name, value], rules: [], notices: [] };
  }

  const words = mergeSections(
    iniWords(value).map((word, index) =>
      urlSection(input, `${section}.${name}[${index}]`, word, {
        file,
        format: "ini",
        key: `${section}.${name}[${index}]`,
        urlPassword: true,
      }),
    ),
  );

  return { value: [name, words.values.join("\n")], rules: words.rules, notices: words.notices };
};

const sectionOf = (input: ToolsInput, file: string, section: IniSection): Section<IniSection> => {
  const merged = mergeSections(
    section.entries.map((entry) => entrySection(input, file, section.name, entry)),
  );

  return {
    value: { name: section.name, entries: merged.values },
    rules: merged.rules,
    notices: merged.notices,
  };
};

const withEnvIndex = (input: ToolsInput, sections: IniSection[]): Section<IniSection[]> => {
  const url = input.env.PIP_INDEX_URL;

  if (url === undefined || url === "") {
    return { value: sections, rules: [], notices: [] };
  }

  const index = urlSection(input, "env.PIP_INDEX_URL", url, { env: "PIP_INDEX_URL", urlPassword: true });
  const others = sections.filter((section) => section.name !== GLOBAL);
  const global = sections.find((section) => section.name === GLOBAL)?.entries ?? [];
  const entries: Array<[string, string]> = [
    ...global.filter(([name]) => name !== "index-url"),
    ["index-url", index.value],
  ];

  return { value: [{ name: GLOBAL, entries }, ...others], rules: index.rules, notices: index.notices };
};

export const derivePip = async (input: ToolsInput): Promise<Section<IniSection[] | undefined>> => {
  const config = await firstExisting(configPaths(input));

  if (config === undefined && !input.env.PIP_INDEX_URL) {
    return emptySection(undefined);
  }

  const file = config?.path ?? "";
  const sections = mergeSections(
    parseIni(config?.text ?? "").map((section) => sectionOf(input, file, section)),
  );
  const indexed = withEnvIndex(input, sections.values);

  return {
    value: indexed.value,
    rules: [...sections.rules, ...indexed.rules],
    notices: [...sections.notices, ...indexed.notices],
  };
};
