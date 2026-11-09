export const TOOL_CONFIG_FORMATS = ["json", "npmrc", "ini", "maven-servers"] as const;

export type ToolConfigFormat = (typeof TOOL_CONFIG_FORMATS)[number];

export interface ToolConfigSelect {
  format: ToolConfigFormat;
  key: string;
  urlPassword?: true;
  urlUsername?: true;
}

export interface NpmrcEntry {
  key: string;
  value: string;
}

export interface IniSection {
  name: string;
  entries: Array<[string, string]>;
}

export interface MavenServer {
  id: string;
  username?: string;
  password?: string;
}

export interface MavenRepository {
  id: string;
  url: string;
  mirrorOf?: string;
}

export interface MavenSettings {
  servers: MavenServer[];
  mirrors: MavenRepository[];
  repositories: MavenRepository[];
}

interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
}

const JSON_KEY = /^(\/([^~/]|~[01])*)+$/;

const INI_KEY = /^([^.\s[\]]+)\.([^\s[\]]+)(?:\[([0-9]+)\])?$/;

const PLAIN_KEY = /^[^\s=]+$/;

const SELECTOR = /^\[([^=\]]+)=(.*)\]$/;

const NPMRC_LINE = /^\s*([^\s=;#][^=]*?)\s*=\s*(.*?)\s*$/;

const INI_SECTION = /^\[([^\]]+)\]\s*$/;

const INI_ENTRY = /^([^\s=:;#][^=:]*?)\s*[=:]\s*(.*?)\s*$/;

const INI_CONTINUATION = /^\s+(\S.*?)\s*$/;

const INI_COMMENT = /^\s*([#;].*)?$/;

const XML_TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>|([^<]+)/g;

const XML_ENTITY = /&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/g;

const MAX_CODE_POINT = 0x10ffff;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const unquote = (value: string) =>
  /^"(.*)"$/.test(value) || /^'(.*)'$/.test(value) ? value.slice(1, -1) : value;

const decodeBase64 = (value: string) => Buffer.from(value, "base64").toString("utf8");

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

export const parseNpmrc = (text: string): NpmrcEntry[] =>
  text.split(/\r?\n/).flatMap((line) => {
    const match = NPMRC_LINE.exec(line);

    return match === null ? [] : [{ key: match[1] ?? "", value: unquote(match[2] ?? "") }];
  });

const npmrcValue = (text: string, key: string) => {
  const value = parseNpmrc(text).findLast((entry) => entry.key === key)?.value;

  if (value === undefined) {
    return undefined;
  }

  if (key.endsWith(":_auth")) {
    const decoded = decodeBase64(value);
    const colon = decoded.indexOf(":");

    return colon < 0 ? undefined : decoded.slice(colon + 1);
  }

  return key.endsWith(":_password") ? decodeBase64(value) : value;
};

interface IniState {
  sections: IniSection[];
  last?: [string, string];
}

const iniLine = (state: IniState, line: string): IniState => {
  const continuation = INI_CONTINUATION.exec(line);

  if (continuation !== null && state.last !== undefined && !INI_COMMENT.test(line)) {
    state.last[1] = state.last[1] === "" ? (continuation[1] ?? "") : `${state.last[1]}\n${continuation[1]}`;

    return state;
  }

  if (INI_COMMENT.test(line)) {
    return { sections: state.sections };
  }

  const section = INI_SECTION.exec(line.trim());

  if (section !== null) {
    return { sections: [...state.sections, { name: (section[1] ?? "").trim(), entries: [] }] };
  }

  const entry = INI_ENTRY.exec(line);
  const current = state.sections.at(-1);

  if (entry === null || current === undefined) {
    return { sections: state.sections };
  }

  const pair: [string, string] = [(entry[1] ?? "").toLowerCase(), entry[2] ?? ""];

  current.entries.push(pair);

  return { sections: state.sections, last: pair };
};

export const parseIni = (text: string): IniSection[] =>
  text.split(/\r?\n/).reduce<IniState>(iniLine, { sections: [] }).sections;

export const iniWords = (value: string) => value.split(/\s+/).filter((word) => word !== "");

const iniValue = (text: string, key: string) => {
  const match = INI_KEY.exec(key);

  if (match === null) {
    return undefined;
  }

  const [, section, name, index] = match;
  const value = parseIni(text)
    .filter((entry) => entry.name === section)
    .flatMap((entry) => entry.entries)
    .findLast(([entryName]) => entryName === name?.toLowerCase())?.[1];

  return value === undefined || index === undefined ? value : iniWords(value)[Number(index)];
};

const decodeEntities = (text: string) =>
  text.replace(XML_ENTITY, (_, entity: string) => {
    if (!entity.startsWith("#")) {
      return NAMED_ENTITIES[entity] ?? "";
    }

    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));

    return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : "";
  });

const xmlStep = (stack: XmlElement[] | undefined, token: RegExpMatchArray) => {
  const top = stack?.at(-1);

  if (stack === undefined || top === undefined) {
    return undefined;
  }

  const [, cdata, closing, opening, selfClosing, text] = token;

  if (opening !== undefined) {
    const element = { name: opening, children: [], text: "" };

    top.children.push(element);

    return selfClosing === "/" ? stack : [...stack, element];
  }

  if (closing !== undefined) {
    return closing === top.name ? stack.slice(0, -1) : undefined;
  }

  const content = cdata ?? (text === undefined ? undefined : decodeEntities(text));

  top.text += content ?? "";

  return stack;
};

const parseXml = (text: string) => {
  const root: XmlElement = { name: "", children: [], text: "" };
  const stack = [...text.matchAll(XML_TOKEN)].reduce<XmlElement[] | undefined>(xmlStep, [root]);

  return stack?.length === 1 ? root : undefined;
};

const childrenOf = (element: XmlElement | undefined, name: string) =>
  element?.children.filter((child) => child.name === name) ?? [];

const childText = (element: XmlElement, name: string) => {
  const value = childrenOf(element, name)[0]?.text.trim();

  return value === undefined || value === "" ? undefined : value;
};

const repositoryOf = (element: XmlElement): MavenRepository[] => {
  const id = childText(element, "id");
  const url = childText(element, "url");
  const mirrorOf = childText(element, "mirrorOf");

  if (id === undefined || url === undefined) {
    return [];
  }

  return [mirrorOf === undefined ? { id, url } : { id, url, mirrorOf }];
};

const serverOf = (element: XmlElement): MavenServer[] => {
  const id = childText(element, "id");
  const username = childText(element, "username");
  const password = childText(element, "password");

  if (id === undefined) {
    return [];
  }

  return [
    {
      id,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
    },
  ];
};

const nested = (elements: XmlElement[], path: string[]): XmlElement[] =>
  path.reduce((level, name) => level.flatMap((element) => childrenOf(element, name)), elements);

export const parseMavenSettings = (text: string): MavenSettings | undefined => {
  const settings = childrenOf(parseXml(text), "settings");

  if (settings.length !== 1) {
    return undefined;
  }

  const profiles = nested(settings, ["profiles", "profile"]);

  return {
    servers: nested(settings, ["servers", "server"]).flatMap(serverOf),
    mirrors: nested(settings, ["mirrors", "mirror"]).flatMap(repositoryOf),
    repositories: [
      ...nested(profiles, ["repositories", "repository"]),
      ...nested(profiles, ["pluginRepositories", "pluginRepository"]),
    ].flatMap(repositoryOf),
  };
};

const mavenServerPassword = (text: string, id: string) =>
  parseMavenSettings(text)?.servers.find((server) => server.id === id)?.password;

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
  "maven-servers": mavenServerPassword,
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
