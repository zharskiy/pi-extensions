import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layerConstraints, layerKeys } from "../../config/validate.ts";

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  required?: string[];
  enum?: unknown[];
  const?: unknown;
}

const joinPath = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

const schemaKeys = (node: SchemaNode, path: string): string[] => [
  ...Object.entries(node.properties ?? {}).flatMap(([key, child]) => [
    joinPath(path, key),
    ...schemaKeys(child, joinPath(path, key)),
  ]),
  ...(node.oneOf ?? []).flatMap((variant) => schemaKeys(variant, path)),
  ...(node.items === undefined ? [] : schemaKeys(node.items, `${path}[]`)),
];

const schemaValues = (node: SchemaNode) => {
  if (node.enum?.every((value) => typeof value === "string")) {
    return node.enum as string[];
  }

  return typeof node.const === "string" ? [node.const] : undefined;
};

const schemaConstraints = (node: SchemaNode, path: string): string[] => {
  const values = schemaValues(node);

  return [
    ...(node.required === undefined || node.properties === undefined
      ? []
      : [`${path} requires ${node.required.join(", ")}`]),
    ...(values === undefined ? [] : [`${path} is one of ${values.join(", ")}`]),
    ...Object.entries(node.properties ?? {}).flatMap(([key, child]) =>
      schemaConstraints(child, joinPath(path, key)),
    ),
    ...(node.oneOf ?? []).flatMap((variant) => schemaConstraints(variant, path)),
    ...(node.items === undefined ? [] : schemaConstraints(node.items, `${path}[]`)),
  ];
};

const validatorConstraints = () =>
  layerConstraints().map(({ path, required, values }) =>
    required === undefined
      ? `${path} is one of ${values?.join(", ")}`
      : `${path} requires ${required.join(", ")}`,
  );

const distinctSorted = (items: string[]) => [...new Set(items)].sort();

const readSchema = async () => {
  const file = join(import.meta.dirname, "..", "..", "schema", "sandbox-config.schema.json");

  return JSON.parse(await readFile(file, "utf8")) as SchemaNode & { $schema: string };
};

describe("sandbox-config.schema.json", () => {
  it("names exactly the keys the validator accepts", async () => {
    const schema = await readSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(distinctSorted(schemaKeys(schema, ""))).toEqual(distinctSorted(layerKeys()));
  });

  it("requires the same keys and offers the same choices as the validator", async () => {
    expect(distinctSorted(schemaConstraints(await readSchema(), ""))).toEqual(
      distinctSorted(validatorConstraints()),
    );
  });
});
