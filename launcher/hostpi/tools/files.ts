import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hasUrlUserinfo, type ToolConfigFormat } from "../../shared/index.ts";
import { type Endpoint, endpointOf, withoutUserinfo } from "../endpoints.ts";
import { isInsideRoots } from "../path-search.ts";
import { noticeOnly, placeholderOf, rulesFor, type Section } from "../rules.ts";
import type { ToolsInput } from "../types.ts";

export const PROBE_TIMEOUT_MS = 10_000;

export const TOKEN_PROBE_TIMEOUT_MS = 30_000;

export const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);

export const firstExisting = async (paths: string[]) => {
  const texts = await Promise.all(paths.map(readOptional));
  const index = texts.findIndex((text) => text !== undefined);

  return index < 0 ? undefined : { path: paths[index] ?? "", text: texts[index] ?? "" };
};

export const sandboxedConfigNotice = async (
  input: ToolsInput,
  label: string,
  variable: string,
  path: string,
) =>
  (await isInsideRoots(path, input.excludedRoots))
    ? `${label}: ${path} (from ${variable}) lies inside the sandbox, which can rewrite it; ignored`
    : undefined;

export const xdgConfigHome = (input: ToolsInput) => input.env.XDG_CONFIG_HOME || join(input.home, ".config");

export const timedOutNotice = (label: string, command: string, timeoutMs = PROBE_TIMEOUT_MS) =>
  `${label}: ${command} did not answer within ${timeoutMs / 1000} s on the host; skipped`;

export const noCredentialsNotice = (label: string, command: string, timeoutMs: number) =>
  `${label}: ${command} did not answer within ${timeoutMs / 1000} s on the host (a Keychain prompt may be waiting); it has no credentials in the sandbox this launch, run pi again once it answers`;

export interface Registry {
  label: string;
  endpoint: Endpoint;
}

export const registriesOf = (label: string, urls: string[]): Registry[] =>
  urls.flatMap((url) => {
    const result = endpointOf(withoutUserinfo(url));

    return "endpoint" in result ? [{ label, endpoint: result.endpoint }] : [];
  });

export type UrlSecret = { file: string; format: ToolConfigFormat; key: string };

export interface UrlCredential {
  label: string;
  key: string;
  identity: string;
  url: string;
  secret: UrlSecret;
  pathPrefix?: (path: string) => string | undefined;
}

export const urlCredentialSection = (input: ToolsInput, credential: UrlCredential): Section<string> => {
  if (!hasUrlUserinfo(credential.url)) {
    return noticeOnly(credential.url);
  }

  const result = endpointOf(credential.url);

  if (!("endpoint" in result)) {
    return noticeOnly(
      withoutUserinfo(credential.url),
      `${credential.label}: ${credential.key} is not an https URL; its credentials stay on the host`,
    );
  }

  const placeholder = placeholderOf(input, credential.identity);
  const parsed = new URL(credential.url);
  const part = parsed.password === "" ? { urlUsername: true as const } : { urlPassword: true as const };

  if (parsed.password === "") {
    parsed.username = placeholder;
  } else {
    parsed.password = placeholder;
  }

  const pathPrefix = credential.pathPrefix?.(parsed.pathname);

  return {
    value: parsed.href,
    rules: rulesFor(credential.identity, [result.endpoint], {
      placeholder,
      secret: { ...credential.secret, ...part },
    }).map((rule) => (pathPrefix === undefined ? rule : { ...rule, pathPrefix })),
    notices: [],
  };
};
