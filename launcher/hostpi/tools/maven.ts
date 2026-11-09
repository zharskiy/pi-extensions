import { join } from "node:path";
import type { SecretRef } from "../../config/index.ts";
import {
  isSecretName,
  type MavenHeader,
  type MavenRepository,
  type MavenServer,
  type MavenSettings,
  parseMavenSettings,
  type XmlElement,
} from "../../shared/index.ts";
import { type Endpoint, endpointOf, hasUrlUserinfo, uniqueEndpoints, withoutUserinfo } from "../endpoints.ts";
import { mergeSections, rulesFor, type Section } from "../rules.ts";
import type { DerivedTools, ToolsInput } from "../types.ts";
import { emptySection, placeholderRules, readOptional, toolPlaceholder } from "./files.ts";

type MavenRender = DerivedTools["maven"];

const ENCRYPTED = /^\{[^}]*\}$/;

const ENV_REFERENCE = /^\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

const NO_SETTINGS: MavenRender = { servers: [], mirrors: [], passthrough: [] };

const endpointsFor = (settings: MavenSettings, id: string): Endpoint[] =>
  uniqueEndpoints(
    [...settings.mirrors, ...settings.repositories]
      .filter((repository) => repository.id === id)
      .flatMap((repository) => {
        const result = endpointOf(repository.url);

        return "endpoint" in result ? [result.endpoint] : [];
      }),
  );

interface ServerContext {
  input: ToolsInput;
  file: string;
  endpoints: Endpoint[];
}

const secretOf = (value: string, file: string, key: string): SecretRef => {
  const variable = ENV_REFERENCE.exec(value)?.[1];

  return variable === undefined ? { file, format: "maven-servers", key } : { env: variable };
};

const passwordSection = (context: ServerContext, server: MavenServer, password: string): Section<string> => {
  const identity = `maven:${server.id}:password`;
  const placeholder = toolPlaceholder(context.input, identity);

  return {
    value: placeholder,
    rules: placeholderRules(
      identity,
      context.endpoints,
      placeholder,
      secretOf(password, context.file, server.id),
    ),
    notices: [],
  };
};

const headerSection = (
  context: ServerContext,
  server: MavenServer,
  header: MavenHeader,
): Section<MavenHeader[]> => {
  if (ENCRYPTED.test(header.value)) {
    return {
      value: [],
      rules: [],
      notices: [
        `maven ${server.id}: the ${header.name} header is encrypted with settings-security.xml and stays on the host`,
      ],
    };
  }

  const identity = `maven:${server.id}:header:${header.name}`;
  const placeholder = toolPlaceholder(context.input, identity);
  const secret = secretOf(header.value, context.file, `${server.id}/httpHeaders/${header.name}`);

  return {
    value: [{ name: header.name, value: placeholder }],
    rules: rulesFor(identity, context.endpoints, { placeholder, header: header.name, secret }),
    notices: [],
  };
};

const credentialSection = (
  context: ServerContext,
  server: MavenServer,
  password: string | undefined,
): Section<MavenServer[]> => {
  const secured = password === undefined ? undefined : passwordSection(context, server, password);
  const headers = mergeSections(
    (server.headers ?? []).map((header) => headerSection(context, server, header)),
  );
  const sections = [...(secured === undefined ? [] : [secured]), headers];
  const kept = headers.values.flat();
  const { headers: _headers, ...rest } = server;

  return {
    value: [
      {
        ...rest,
        ...(secured === undefined ? {} : { password: secured.value }),
        ...(kept.length === 0 ? {} : { headers: kept }),
      },
    ],
    rules: sections.flatMap((section) => section.rules),
    notices: sections.flatMap((section) => section.notices),
  };
};

const serverSection = (
  input: ToolsInput,
  file: string,
  settings: MavenSettings,
  server: MavenServer,
): Section<MavenServer[]> => {
  const { password } = server;
  const hasCredential = password !== undefined || (server.headers ?? []).length > 0;

  if (!hasCredential) {
    return server.keyed === true
      ? {
          value: [],
          rules: [],
          notices: [`maven ${server.id}: a privateKey or passphrase stays on the host`],
        }
      : emptySection([server]);
  }

  if (password !== undefined && ENCRYPTED.test(password)) {
    return {
      value: [],
      rules: [],
      notices: [
        `maven ${server.id}: the password is encrypted with settings-security.xml and stays on the host`,
      ],
    };
  }

  const endpoints = endpointsFor(settings, server.id);

  if (endpoints.length === 0) {
    return {
      value: [],
      rules: [],
      notices: [
        `maven ${server.id}: no mirror or profile repository with this id has an https URL; add a credentials.rules entry for its host`,
      ],
    };
  }

  return credentialSection({ input, file, endpoints }, server, password);
};

const PROPERTIES = "properties";

const sanitizedUrl = (element: XmlElement): Section<XmlElement> =>
  hasUrlUserinfo(element.text.trim())
    ? {
        value: { ...element, text: withoutUserinfo(element.text.trim()) },
        rules: [],
        notices: [
          "maven profiles: a repository URL carried user credentials; they stay on the host, put them in a <server> with its id",
        ],
      }
    : emptySection(element);

const sanitizedChild = (parent: string, element: XmlElement): Section<XmlElement[]> => {
  if (parent === PROPERTIES && isSecretName(element.name)) {
    return {
      value: [],
      rules: [],
      notices: [`maven profiles: the property ${element.name} looks like a secret and stays on the host`],
    };
  }

  const section = sanitized(element);

  return { ...section, value: [section.value] };
};

const sanitized = (element: XmlElement): Section<XmlElement> => {
  if (element.name === "url" && element.children.length === 0) {
    return sanitizedUrl(element);
  }

  const children = mergeSections(element.children.map((child) => sanitizedChild(element.name, child)));

  return { value: { ...element, children: children.values.flat() }, rules: [], notices: children.notices };
};

const localRepositoryNotices = (settings: MavenSettings) =>
  settings.localRepository === undefined
    ? []
    : [
        `maven: localRepository ${settings.localRepository} is not used in the sandbox; Maven there uses ~/.m2/repository`,
      ];

const mirrorSection = (mirror: MavenRepository): Section<MavenRepository> =>
  hasUrlUserinfo(mirror.url)
    ? {
        value: { ...mirror, url: withoutUserinfo(mirror.url) },
        rules: [],
        notices: [
          `maven ${mirror.id}: the mirror URL carried user credentials; they stay on the host, put them in a <server> with id ${mirror.id}`,
        ],
      }
    : emptySection(mirror);

export const deriveMaven = async (input: ToolsInput): Promise<Section<MavenRender>> => {
  const file = join(input.home, ".m2", "settings.xml");
  const text = await readOptional(file);

  if (text === undefined) {
    return emptySection(NO_SETTINGS);
  }

  const settings = parseMavenSettings(text);

  if (settings === undefined) {
    return { value: NO_SETTINGS, rules: [], notices: [`${file}: not a Maven settings document, ignored`] };
  }

  const merged = mergeSections(
    settings.servers.map((server) => serverSection(input, file, settings, server)),
  );
  const mirrors = mergeSections(settings.mirrors.map(mirrorSection));
  const passthrough = mergeSections(settings.passthrough.map(sanitized));

  return {
    value: { servers: merged.values.flat(), mirrors: mirrors.values, passthrough: passthrough.values },
    rules: merged.rules,
    notices: [
      ...merged.notices,
      ...mirrors.notices,
      ...passthrough.notices,
      ...localRepositoryNotices(settings),
    ],
  };
};
