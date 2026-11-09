import { join } from "node:path";
import type { SecretRef } from "../../config/index.ts";
import { type MavenServer, type MavenSettings, parseMavenSettings } from "../../shared/index.ts";
import { type Endpoint, endpointOf, uniqueEndpoints } from "../endpoints.ts";
import { mergeSections, type Section } from "../rules.ts";
import type { DerivedTools, ToolsInput } from "../types.ts";
import { emptySection, placeholderRules, readOptional, toolPlaceholder } from "./files.ts";

type MavenRender = DerivedTools["maven"];

const ENCRYPTED = /^\{[^}]*\}$/;

const ENV_REFERENCE = /^\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}$/;

const NO_SETTINGS: MavenRender = { servers: [], mirrors: [] };

const endpointsFor = (settings: MavenSettings, id: string): Endpoint[] =>
  uniqueEndpoints(
    [...settings.mirrors, ...settings.repositories]
      .filter((repository) => repository.id === id)
      .flatMap((repository) => {
        const result = endpointOf(repository.url);

        return "endpoint" in result ? [result.endpoint] : [];
      }),
  );

const serverSection = (
  input: ToolsInput,
  file: string,
  settings: MavenSettings,
  server: MavenServer,
): Section<MavenServer[]> => {
  const password = server.password;

  if (password === undefined) {
    return { value: [], rules: [], notices: [] };
  }

  if (ENCRYPTED.test(password)) {
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

  const identity = `maven:${server.id}:password`;
  const placeholder = toolPlaceholder(input, identity);
  const variable = ENV_REFERENCE.exec(password)?.[1];
  const secret: SecretRef =
    variable === undefined ? { file, format: "maven-servers", key: server.id } : { env: variable };

  return {
    value: [{ ...server, password: placeholder }],
    rules: placeholderRules(identity, endpoints, placeholder, secret),
    notices: [],
  };
};

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

  return {
    value: { servers: merged.values.flat(), mirrors: settings.mirrors },
    rules: merged.rules,
    notices: merged.notices,
  };
};
