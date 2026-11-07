import type { CredentialRule } from "../config/index.ts";
import { placeholderFor } from "../shared/index.ts";
import type { Endpoint } from "./endpoints.ts";

export type RuleBody = Omit<CredentialRule, "id" | "host" | "port">;

export interface Section<T> {
  value: T;
  rules: CredentialRule[];
  notices: string[];
}

export interface DeriveContext {
  salt: string;
  agentDir: string;
}

export const DERIVED_PREFIX = "derived:";

export const placeholderOf = (context: DeriveContext, identity: string) =>
  placeholderFor(context.salt, identity);

export const rulesFor = (identity: string, endpoints: Endpoint[], body: RuleBody): CredentialRule[] =>
  endpoints.map((endpoint) => ({
    id: `${DERIVED_PREFIX}${identity}`,
    host: endpoint.host,
    ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
    ...body,
  }));

export const mergeSections = <T>(sections: Array<Section<T>>) => ({
  values: sections.map((section) => section.value),
  rules: sections.flatMap((section) => section.rules),
  notices: sections.flatMap((section) => section.notices),
});
