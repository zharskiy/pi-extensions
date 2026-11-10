import { join } from "node:path";
import type { SecretRef } from "../../config/index.ts";
import {
  hasUrlUserinfo,
  isSecretName,
  type MavenHeader,
  type MavenRepository,
  type MavenServer,
  type MavenSettings,
  parseMavenSettings,
  type XmlElement,
} from "../../shared/index.ts";
import { type Endpoint, endpointOf, uniqueEndpoints, withoutUserinfo } from "../endpoints.ts";
import { mergeSections, noticeOnly, placeholderOf, rulesFor, type Section } from "../rules.ts";
import type { DerivedTools, ToolsInput } from "../types.ts";
import { EMPTY_MAVEN } from "../types.ts";
import { type Registry, readOptional, registriesOf } from "./files.ts";

type MavenRender = DerivedTools["maven"];

const ENCRYPTED = /^\{[^}]*\}$/;

const ENV_REFERENCE = /^\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

const ENV_REFERENCES = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

const mixesEnv = (value: string) => value.includes("${env.") && !ENV_REFERENCE.test(value);

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
  const placeholder = placeholderOf(context.input, identity);

  return {
    value: placeholder,
    rules: rulesFor(identity, context.endpoints, {
      placeholder,
      secret: secretOf(password, context.file, server.id),
    }),
    notices: [],
  };
};

const headerSection = (
  context: ServerContext,
  server: MavenServer,
  header: MavenHeader,
): Section<MavenHeader[]> => {
  if (ENCRYPTED.test(header.value)) {
    return noticeOnly(
      [],
      `maven ${server.id}: the ${header.name} header is encrypted with settings-security.xml and stays on the host`,
    );
  }

  if (mixesEnv(header.value)) {
    return noticeOnly(
      [],
      `maven ${server.id}: the ${header.name} header mixes \${env.…} with other text and stays on the host`,
    );
  }

  const identity = `maven:${server.id}:header:${header.name}`;
  const placeholder = placeholderOf(context.input, identity);
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

const expandedUsername = (input: ToolsInput, username: string) => {
  const names = [...username.matchAll(ENV_REFERENCES)].map((reference) => reference[1] ?? "");

  return names.some((name) => isSecretName(name) || input.env[name] === undefined)
    ? undefined
    : username.replace(ENV_REFERENCES, (_, name: string) => input.env[name] ?? "");
};

const usernameOf = (input: ToolsInput, server: MavenServer): { server: MavenServer; notices: string[] } => {
  if (server.username === undefined || !server.username.includes("${env.")) {
    return { server, notices: [] };
  }

  const username = expandedUsername(input, server.username);

  return username === undefined
    ? {
        server,
        notices: [
          `maven ${server.id}: the username reads an environment variable that is unset or secret on the host; it is copied unexpanded`,
        ],
      }
    : { server: { ...server, username }, notices: [] };
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
      ? noticeOnly([], `maven ${server.id}: a privateKey or passphrase stays on the host`)
      : noticeOnly([server]);
  }

  if (password !== undefined && ENCRYPTED.test(password)) {
    return noticeOnly(
      [],
      `maven ${server.id}: the password is encrypted with settings-security.xml and stays on the host`,
    );
  }

  if (password !== undefined && mixesEnv(password)) {
    return noticeOnly(
      [],
      `maven ${server.id}: the password mixes \${env.…} with other text and stays on the host`,
    );
  }

  const endpoints = endpointsFor(settings, server.id);

  if (endpoints.length === 0) {
    return noticeOnly(
      [],
      `maven ${server.id}: no mirror or profile repository with this id has an https URL; add a credentials.rules entry for its host`,
    );
  }

  const user = usernameOf(input, server);
  const section = credentialSection({ input, file, endpoints }, user.server, password);

  return { ...section, notices: [...user.notices, ...section.notices] };
};

const PROFILE_PARTS = new Set(["id", "activation", "repositories", "pluginRepositories"]);

const sanitizedUrl = (element: XmlElement): Section<XmlElement> =>
  hasUrlUserinfo(element.text.trim())
    ? noticeOnly(
        { ...element, text: withoutUserinfo(element.text.trim()) },
        "maven profiles: a repository URL carried user credentials; they stay on the host, put them in a <server> with its id",
      )
    : noticeOnly(element);

const sanitized = (element: XmlElement): Section<XmlElement> => {
  if (element.name === "url" && element.children.length === 0) {
    return sanitizedUrl(element);
  }

  const kept =
    element.name === "profile"
      ? element.children.filter((child) => PROFILE_PARTS.has(child.name))
      : element.children;
  const children = mergeSections(kept.map(sanitized));

  return { value: { ...element, children: children.values }, rules: [], notices: children.notices };
};

const localRepositoryNotices = (settings: MavenSettings) =>
  settings.localRepository === undefined
    ? []
    : [
        `maven: localRepository ${settings.localRepository} is not used in the sandbox; Maven there uses ~/.m2/repository`,
      ];

const mirrorSection = (mirror: MavenRepository): Section<MavenRepository> =>
  hasUrlUserinfo(mirror.url)
    ? noticeOnly(
        { ...mirror, url: withoutUserinfo(mirror.url) },
        `maven ${mirror.id}: the mirror URL carried user credentials; they stay on the host, put them in a <server> with id ${mirror.id}`,
      )
    : noticeOnly(mirror);

export const deriveMaven = async (
  input: ToolsInput,
): Promise<Section<MavenRender> & { registries: Registry[] }> => {
  const file = join(input.home, ".m2", "settings.xml");
  const text = await readOptional(file);

  if (text === undefined) {
    return { ...noticeOnly(EMPTY_MAVEN), registries: [] };
  }

  const settings = parseMavenSettings(text);

  if (settings === undefined) {
    return { ...noticeOnly(EMPTY_MAVEN, `${file}: not a Maven settings document, ignored`), registries: [] };
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
    registries: registriesOf(
      "maven",
      [...settings.mirrors, ...settings.repositories].map((repository) => repository.url),
    ),
  };
};
