import type { SecretRef } from "../config/index.ts";
import { isSecretName } from "../shared/index.ts";
import { type Endpoint, endpointOf } from "./endpoints.ts";
import { jsonPointer } from "./json.ts";
import { rulesFor, type Section } from "./rules.ts";

export interface UserinfoTarget {
  label: string;
  key: string;
  identity: string;
  file: string;
  pointer: Array<string | number>;
  secret?: SecretRef;
}

const parsed = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
};

const SECRET_QUERY_NAME = /^(auth|sig|signature|pass|passwd|pwd)$/i;

export const hasQueryCredential = (url: unknown) => {
  const parts = typeof url === "string" ? parsed(url) : undefined;

  return [...(parts?.searchParams.keys() ?? [])].some(
    (name) => isSecretName(name) || SECRET_QUERY_NAME.test(name),
  );
};

export const hasUrlPassword = (url: unknown) =>
  typeof url === "string" && (parsed(url)?.password ?? "") !== "";

export const stripUserinfo = (target: UserinfoTarget, url: unknown): Section<unknown> => {
  const parts = typeof url === "string" ? parsed(url) : undefined;

  if (parts === undefined || (parts.username === "" && parts.password === "")) {
    return { value: url, rules: [], notices: [] };
  }

  const hadPassword = parts.password !== "";
  const result = endpointOf(url);
  const endpoints: Endpoint[] = "endpoint" in result ? [result.endpoint] : [];

  parts.username = "";

  parts.password = "";

  return {
    value: parts.href,
    rules: hadPassword
      ? rulesFor(target.identity, endpoints, {
          header: "Authorization",
          template: "Basic {secret}",
          transform: "urlUserinfoBase64",
          secret: target.secret ?? { file: target.file, pointer: jsonPointer(target.pointer) },
        })
      : [],
    notices: [`${target.label}: ${target.key} carried user credentials; they were removed in the sandbox`],
  };
};
