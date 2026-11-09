import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { CredentialRule } from "../../config/index.ts";
import { placeholderFor } from "../../shared/index.ts";
import type { Endpoint } from "../endpoints.ts";
import { rulesFor, type Section } from "../rules.ts";
import type { ToolsInput } from "../types.ts";

export const COMMAND_TTL_SECONDS = 300;

export const readOptional = (path: string) => readFile(path, "utf8").catch(() => undefined);

export const firstExisting = async (paths: string[]) => {
  const texts = await Promise.all(paths.map(readOptional));
  const index = texts.findIndex((text) => text !== undefined);

  return index < 0 ? undefined : { path: paths[index] ?? "", text: texts[index] ?? "" };
};

const isExecutable = async (path: string) => {
  const info = await stat(path).catch(() => undefined);

  return (
    info?.isFile() === true &&
    (await access(path, constants.X_OK).then(
      () => true,
      () => false,
    ))
  );
};

export const onPath = async (input: ToolsInput, name: string) => {
  const candidates = (input.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.startsWith("/"))
    .map((dir) => join(dir, name));
  const found = await Promise.all(candidates.map(isExecutable));

  return candidates.find((_, index) => found[index]);
};

export const xdgConfigHome = (input: ToolsInput) => input.env.XDG_CONFIG_HOME || join(input.home, ".config");

export const toolPlaceholder = (input: ToolsInput, identity: string) => placeholderFor(input.salt, identity);

export const placeholderRules = (
  identity: string,
  endpoints: Endpoint[],
  placeholder: string,
  secret: CredentialRule["secret"],
): CredentialRule[] => rulesFor(identity, endpoints, { placeholder, secret });

export const emptySection = <T>(value: T): Section<T> => ({ value, rules: [], notices: [] });
