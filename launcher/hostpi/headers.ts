import { SECRET_MARKER, type SecretRef } from "../config/index.ts";
import { isAuthLikeHeader, isJsonObject, isSecretShapedValue } from "../shared/index.ts";
import type { Endpoint } from "./endpoints.ts";
import { jsonPointer } from "./json.ts";
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
  literalSecret?: (name: string) => SecretRef;
}

const CREDENTIAL_WORDS = /auth|cookie|session[-_]?id/i;

const isCredentialHeader = (name: string) => isAuthLikeHeader(name) || CREDENTIAL_WORDS.test(name);

type TemplatePart =
  | { kind: "literal"; text: string; escape?: true }
  | { kind: "env"; name: string; start: number; end: number };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ENV_NAME_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*/;

const literal = (text: string, escaped?: true): TemplatePart =>
  escaped === undefined ? { kind: "literal", text } : { kind: "literal", text, escape: escaped };

const bracedPart = (value: string, dollar: number): [TemplatePart, number] => {
  const close = value.indexOf("}", dollar + 2);

  if (close < 0) {
    return [literal("$"), dollar + 1];
  }

  const name = value.slice(dollar + 2, close);

  return ENV_NAME.test(name)
    ? [{ kind: "env", name, start: dollar, end: close + 1 }, close + 1]
    : [literal(value.slice(dollar, close + 1)), close + 1];
};

const dollarPart = (value: string, dollar: number): [TemplatePart, number] => {
  const next = value[dollar + 1];

  if (next === "$" || next === "!") {
    return [literal(next, true), dollar + 2];
  }

  if (next === "{") {
    return bracedPart(value, dollar);
  }

  const name = ENV_NAME_PREFIX.exec(value.slice(dollar + 1))?.[0];

  return name === undefined
    ? [literal("$"), dollar + 1]
    : [{ kind: "env", name, start: dollar, end: dollar + 1 + name.length }, dollar + 1 + name.length];
};

const nextPart = (value: string, index: number): [TemplatePart, number] => {
  const dollar = value.indexOf("$", index);

  if (dollar < 0) {
    return [literal(value.slice(index)), value.length];
  }

  return dollar > index ? [literal(value.slice(index, dollar)), dollar] : dollarPart(value, dollar);
};

const templateParts = (value: string, index = 0): TemplatePart[] => {
  if (index >= value.length) {
    return [];
  }

  const [part, next] = nextPart(value, index);

  return [part, ...templateParts(value, next)];
};

const readsHostValue = (value: string) =>
  value.startsWith("!") || templateParts(value).some((part) => part.kind === "env");

export const carriesCredential = (name: string, value: unknown) =>
  isCredentialHeader(name) ||
  (typeof value === "string" && (readsHostValue(value) || isSecretShapedValue(value)));

const whole = (secret: SecretRef): Binding => ({
  kind: "bound",
  secret,
  fileValue: (placeholder) => placeholder,
  template: SECRET_MARKER,
});

const embedded = (
  value: string,
  parts: TemplatePart[],
  reference: TemplatePart & { kind: "env" },
): Binding => ({
  kind: "bound",
  secret: { env: reference.name },
  fileValue: (placeholder) => `${value.slice(0, reference.start)}${placeholder}${value.slice(reference.end)}`,
  template: parts.map((part) => (part.kind === "env" ? SECRET_MARKER : part.text)).join(""),
});

const literalBinding = (
  name: string,
  value: string,
  parts: TemplatePart[],
  literalSecret: SecretRef,
): Binding => {
  if (!carriesCredential(name, value)) {
    return { kind: "keep" };
  }

  return parts.some((part) => part.kind === "literal" && part.escape === true)
    ? { kind: "unbound" }
    : whole(literalSecret);
};

const bindingOf = (name: string, value: unknown, literalSecret: SecretRef): Binding => {
  if (typeof value !== "string") {
    return { kind: "keep" };
  }

  if (value.startsWith("!")) {
    return whole({ command: ["sh", "-c", value.slice(1)] });
  }

  const parts = templateParts(value);
  const references = parts.filter((part): part is TemplatePart & { kind: "env" } => part.kind === "env");
  const [reference] = references;

  if (reference === undefined) {
    return literalBinding(name, value, parts, literalSecret);
  }

  if (references.length > 1) {
    return { kind: "unbound" };
  }

  return parts.length === 1 ? whole({ env: reference.name }) : embedded(value, parts, reference);
};

const headerSection = (
  context: DeriveContext,
  target: HeaderTarget,
  name: string,
  value: unknown,
): Section<[string, unknown]> => {
  const identity = `${target.identity}:header:${name.toLowerCase()}`;
  const placeholder = placeholderOf(context, identity);
  const literal = target.literalSecret?.(name) ?? {
    file: target.file,
    pointer: jsonPointer([...target.pointer, name]),
  };
  const binding = bindingOf(name, value, literal);

  if (binding.kind === "keep") {
    return { value: [name, value], rules: [], notices: [] };
  }

  if (binding.kind === "unbound") {
    return {
      value: [name, placeholder],
      rules: [],
      notices: [
        `${target.label}: header ${name} combines several variables or escapes; it is a placeholder in the sandbox, add credentials.rules for it`,
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

  const lastByName = new Map(Object.entries(headers).map((entry) => [entry[0].toLowerCase(), entry]));
  const merged = mergeSections(
    [...lastByName.values()].map(([name, value]) => headerSection(context, target, name, value)),
  );

  return { value: Object.fromEntries(merged.values), rules: merged.rules, notices: merged.notices };
};
