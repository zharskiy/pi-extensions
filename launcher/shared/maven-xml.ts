export interface XmlElement {
  name: string;
  children: XmlElement[];
  text: string;
}

export interface MavenHeader {
  name: string;
  value: string;
}

export interface MavenServer {
  id: string;
  username?: string;
  password?: string;
  headers?: MavenHeader[];
  configuration?: XmlElement[];
  keyed?: true;
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
  passthrough: XmlElement[];
  localRepository?: string;
}

const XML_TOKEN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(\/?)>|([^<]+)/g;

const XML_ENTITY = /&(lt|gt|amp|quot|apos|#[0-9]+|#x[0-9A-Fa-f]+);/g;

const MAX_CODE_POINT = 0x10ffff;

const NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

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

const nested = (elements: XmlElement[], path: string[]): XmlElement[] =>
  path.reduce((level, name) => level.flatMap((element) => childrenOf(element, name)), elements);

const HEADERS = "httpHeaders";

const KEY_FIELDS = ["privateKey", "passphrase"];

const PASSTHROUGH = ["profiles", "activeProfiles", "pluginGroups"];

const HEADER_KEY = /^(.+)\/httpHeaders\/(.+)$/;

const headersOf = (server: XmlElement) =>
  nested([server], ["configuration", HEADERS, "property"]).flatMap((property) => {
    const name = childText(property, "name");
    const value = childText(property, "value");

    return name === undefined || value === undefined ? [] : [{ name, value }];
  });

const configurationOf = (server: XmlElement) =>
  childrenOf(server, "configuration").flatMap((configuration) =>
    configuration.children.filter((child) => child.name !== HEADERS),
  );

const serverOf = (element: XmlElement): MavenServer[] => {
  const id = childText(element, "id");
  const username = childText(element, "username");
  const password = childText(element, "password");
  const headers = headersOf(element);
  const configuration = configurationOf(element);
  const keyed = KEY_FIELDS.some((name) => childText(element, name) !== undefined);

  if (id === undefined) {
    return [];
  }

  return [
    {
      id,
      ...(username === undefined ? {} : { username }),
      ...(password === undefined ? {} : { password }),
      ...(headers.length === 0 ? {} : { headers }),
      ...(configuration.length === 0 ? {} : { configuration }),
      ...(keyed ? { keyed: true as const } : {}),
    },
  ];
};

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export const escapeXml = (text: string) =>
  text.replace(/[&<>"]/g, (character) => XML_ESCAPES[character] ?? character);

export const xmlLines = (element: XmlElement, indent: string): string[] =>
  element.children.length === 0
    ? [`${indent}<${element.name}>${escapeXml(element.text.trim())}</${element.name}>`]
    : [
        `${indent}<${element.name}>`,
        ...element.children.flatMap((child) => xmlLines(child, `${indent}  `)),
        `${indent}</${element.name}>`,
      ];

export const parseMavenSettings = (text: string): MavenSettings | undefined => {
  const settings = childrenOf(parseXml(text), "settings");

  if (settings.length !== 1) {
    return undefined;
  }

  const profiles = nested(settings, ["profiles", "profile"]);
  const localRepository = settings[0] === undefined ? undefined : childText(settings[0], "localRepository");

  return {
    servers: nested(settings, ["servers", "server"]).flatMap(serverOf),
    mirrors: nested(settings, ["mirrors", "mirror"]).flatMap(repositoryOf),
    repositories: [
      ...nested(profiles, ["repositories", "repository"]),
      ...nested(profiles, ["pluginRepositories", "pluginRepository"]),
    ].flatMap(repositoryOf),
    passthrough: settings.flatMap((element) =>
      element.children.filter((child) => PASSTHROUGH.includes(child.name)),
    ),
    ...(localRepository === undefined ? {} : { localRepository }),
  };
};

export const mavenServerSecret = (text: string, key: string) => {
  const header = HEADER_KEY.exec(key);
  const id = header?.[1] ?? key;
  const server = parseMavenSettings(text)?.servers.find((candidate) => candidate.id === id);

  return header === null
    ? server?.password
    : server?.headers?.find((entry) => entry.name === header[2])?.value;
};
