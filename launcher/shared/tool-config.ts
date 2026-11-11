import { INI_KEY, iniValue } from "./ini.ts";
import { mavenServerSecret } from "./maven-xml.ts";
import { npmrcValue } from "./npmrc.ts";

export const TOOL_CONFIG_FORMATS = ["json", "npmrc", "ini", "maven-servers"] as const;

export type ToolConfigFormat = (typeof TOOL_CONFIG_FORMATS)[number];

export interface ToolConfigSelect {
  format: ToolConfigFormat;
  key: string;
  urlPassword?: true;
  urlUsername?: true;
}

const JSON_KEY = /^(\/([^~/]|~[01])*)+$/;

const PLAIN_KEY = /^[^\s=]+$/;

const SELECTOR = /^\[([^=\]]+)=(.*)\]$/;

const urlPasswordOf = (value: string | undefined) => {
  if (value === undefined || !URL.canParse(value)) {
    return undefined;
  }

  const password = new URL(value).password;

  return password === "" ? undefined : decodeURIComponent(password);
};

const urlUsernameOf = (value: string | undefined) => {
  if (value === undefined || !URL.canParse(value)) {
    return undefined;
  }

  const username = new URL(value).username;

  return username === "" ? undefined : decodeURIComponent(username);
};

export const urlPartOf = (value: string | undefined, select: { urlPassword?: true; urlUsername?: true }) => {
  if (select.urlPassword === true) {
    return urlPasswordOf(value);
  }

  return select.urlUsername === true ? urlUsernameOf(value) : value;
};

const unescapeToken = (token: string) => token.replaceAll("~1", "/").replaceAll("~0", "~");

const jsonStep = (value: unknown, token: string) => {
  const selector = SELECTOR.exec(token);

  if (selector !== null) {
    const [, field = "", wanted] = selector;

    return Array.isArray(value)
      ? value.find((item) => typeof item === "object" && item !== null && item[field] === wanted)
      : undefined;
  }

  return typeof value === "object" && value !== null && Object.hasOwn(value, token)
    ? (value as Record<string, unknown>)[token]
    : undefined;
};

const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const jsonValue = (text: string, key: string) => {
  const value = key
    .split("/")
    .slice(1)
    .map(unescapeToken)
    .reduce<unknown>((current, token) => jsonStep(current, token), parseJson(text));

  return typeof value === "string" ? value : undefined;
};

const READERS: Record<ToolConfigFormat, (text: string, key: string) => string | undefined> = {
  json: jsonValue,
  npmrc: npmrcValue,
  ini: iniValue,
  "maven-servers": mavenServerSecret,
};

const KEY_PATTERNS: Record<ToolConfigFormat, RegExp> = {
  json: JSON_KEY,
  npmrc: PLAIN_KEY,
  ini: INI_KEY,
  "maven-servers": PLAIN_KEY,
};

export const isToolConfigKey = (format: ToolConfigFormat, key: string) =>
  KEY_PATTERNS[format]?.test(key) ?? false;

export const toolConfigValue = (text: string, select: ToolConfigSelect) => {
  return urlPartOf(READERS[select.format](text, select.key), select);
};
