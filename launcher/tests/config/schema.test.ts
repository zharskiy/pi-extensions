import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layerKeys } from "../../config/validate.ts";

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
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

describe("sandbox-config.schema.json", () => {
  it("names exactly the keys the validator accepts", async () => {
    const file = join(import.meta.dirname, "..", "..", "schema", "sandbox-config.schema.json");
    const schema = JSON.parse(await readFile(file, "utf8")) as SchemaNode & { $schema: string };

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect([...new Set(schemaKeys(schema, ""))].sort()).toEqual([...new Set(layerKeys())].sort());
  });
});
