import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layerKeys, validateLayer } from "../../config/validate.ts";

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  pattern?: string;
}

const SHARED_CACHE_SAMPLES = [
  "~/.cache/pip",
  "~/.npm/",
  "~/.pix",
  "~/..x",
  "~",
  "~/",
  "/abs",
  "relative",
  "~/a/../b",
  "~/a//b",
  "~/./a",
  "~/a/.",
  "~/.pi",
  "~/.pi/agent",
  "~/.config",
  "~/.ssh/keys",
  "~/.gnupg",
  "~/.aws/sso",
  "~/.docker",
  "~/.colima/",
  "~/.kube",
  "~/.local/bin",
  "~/.local/bin/tool",
  "~/.local/share",
  "~/.local/binx",
];

const joinPath = (prefix: string, key: string) => (prefix === "" ? key : `${prefix}.${key}`);

const schemaKeys = (node: SchemaNode, path: string): string[] => [
  ...Object.entries(node.properties ?? {}).flatMap(([key, child]) => [
    joinPath(path, key),
    ...schemaKeys(child, joinPath(path, key)),
  ]),
  ...(node.oneOf ?? []).flatMap((variant) => schemaKeys(variant, path)),
  ...(node.items === undefined ? [] : schemaKeys(node.items, `${path}[]`)),
];

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

  it("accepts and refuses the same shared cache paths as the validator", async () => {
    const pattern = new RegExp(
      (await readSchema()).properties?.mounts?.properties?.sharedCaches?.items?.pattern ?? "",
    );
    const accepted = (path: string) => {
      try {
        validateLayer({ mounts: { sharedCaches: [path] } }, "user");

        return true;
      } catch {
        return false;
      }
    };

    expect(SHARED_CACHE_SAMPLES.map((path) => [path, pattern.test(path)])).toEqual(
      SHARED_CACHE_SAMPLES.map((path) => [path, accepted(path)]),
    );
  });
});
