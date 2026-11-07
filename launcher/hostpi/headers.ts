import type { SecretRef } from "../config/index.ts";
import { isAuthLikeHeader } from "../shared/index.ts";
import type { Endpoint } from "./endpoints.ts";
import { isJsonObject, jsonPointer } from "./json.ts";
import { type DeriveContext, mergeSections, placeholderOf, rulesFor, type Section } from "./rules.ts";
import type { JsonObject } from "./types.ts";

type Binding =
  | { kind: "keep" }
  | { kind: "unbound" }
  | { kind: "bound"; secret: SecretRef; fileValue: (placeholder: string) => string; template: string };

export interface HeaderTarget {
  label: string;
  identity: string;
  file: string;
  pointer: Array<string | number>;
  endpoints: Endpoint[];
}

const SECRET_SLOT = "{secret}";

const WHOLE_VARIABLE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

const BRACED_VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const whole = (secret: SecretRef): Binding => ({
  kind: "bound",
  secret,
  fileValue: (placeholder) => placeholder,
  template: SECRET_SLOT,
});

const embedded = (value: string, reference: string, name: string): Binding => ({
  kind: "bound",
  secret: { env: name },
  fileValue: (placeholder) => value.split(reference).join(placeholder),
  template: value.split(reference).join(SECRET_SLOT),
});

const bindingOf = (name: string, value: unknown, file: string, pointer: string): Binding => {
  if (typeof value !== "string") {
    return { kind: "keep" };
  }

  if (value.startsWith("!")) {
    return whole({ command: ["sh", "-c", value.slice(1)] });
  }

  const variable = WHOLE_VARIABLE.exec(value);

  if (variable !== null) {
    return whole({ env: variable[1] ?? variable[2] ?? "" });
  }

  const references = [...value.matchAll(BRACED_VARIABLE)];

  if (references.length > 1) {
    return { kind: "unbound" };
  }

  const [reference] = references;

  if (reference !== undefined) {
    return embedded(value, reference[0], reference[1] ?? "");
  }

  return isAuthLikeHeader(name) ? whole({ file, pointer }) : { kind: "keep" };
};

const headerSection = (
  context: DeriveContext,
  target: HeaderTarget,
  name: string,
  value: unknown,
): Section<[string, unknown]> => {
  const identity = `${target.identity}:header:${name.toLowerCase()}`;
  const placeholder = placeholderOf(context, identity);
  const binding = bindingOf(name, value, target.file, jsonPointer([...target.pointer, name]));

  if (binding.kind === "keep") {
    return { value: [name, value], rules: [], notices: [] };
  }

  if (binding.kind === "unbound") {
    return {
      value: [name, placeholder],
      rules: [],
      notices: [
        `${target.label}: header ${name} combines several variables; it is a placeholder in the sandbox, add credentials.rules for it`,
      ],
    };
  }

  return {
    value: [name, binding.fileValue(placeholder)],
    rules: rulesFor(identity, target.endpoints, {
      placeholder,
      header: name,
      template: binding.template,
      secret: binding.secret,
    }),
    notices: [],
  };
};

export const deriveHeaders = (
  context: DeriveContext,
  target: HeaderTarget,
  headers: unknown,
): Section<JsonObject | undefined> => {
  if (!isJsonObject(headers)) {
    return { value: undefined, rules: [], notices: [] };
  }

  const merged = mergeSections(
    Object.entries(headers).map(([name, value]) => headerSection(context, target, name, value)),
  );

  return { value: Object.fromEntries(merged.values), rules: merged.rules, notices: merged.notices };
};
