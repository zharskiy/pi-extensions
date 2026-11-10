import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setPath } from "../../config/dotted.ts";
import { layerKeys, validateLayer } from "../../config/validate.ts";

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  allOf?: SchemaNode[];
  not?: SchemaNode;
  enum?: string[];
  const?: string;
  if?: SchemaNode;
  then?: SchemaNode;
  pattern?: string;
  minLength?: number;
  uniqueItems?: boolean;
  dependentRequired?: Record<string, string[]>;
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

  const stringAccepts = (node: SchemaNode, value: string): boolean =>
    (node.pattern === undefined || new RegExp(node.pattern, "u").test(value)) &&
    (node.minLength === undefined || value.length >= node.minLength) &&
    (node.enum === undefined || node.enum.includes(value)) &&
    (node.const === undefined || node.const === value) &&
    (node.not === undefined || !stringAccepts(node.not, value)) &&
    (node.allOf ?? []).every((part) => stringAccepts(part, value));

  const validatorAccepts = (layer: unknown) => {
    try {
      validateLayer(layer, "user");

      return true;
    } catch {
      return false;
    }
  };

  const rule = (fields: Record<string, unknown>) => ({
    credentials: {
      rules: [
        { id: "r", host: "api.example.test", header: "authorization", secret: { env: "A" }, ...fields },
      ],
    },
  });

  const STRING_CASES: Array<{
    name: string;
    node: (schema: SchemaNode) => SchemaNode | undefined;
    layer: (value: string) => unknown;
    samples: string[];
  }> = [
    ...["allow", "deny"].map((key) => ({
      name: `egress.${key}`,
      node: (schema: SchemaNode) => schema.properties?.egress?.properties?.[key]?.items,
      layer: (value: string) => setPath({}, `egress.${key}`, [value]),
      samples: [
        "a.test",
        "*.a.test",
        "a.test:1",
        "a.test:443",
        "a.test:65535",
        "a.test:0",
        "a.test:65536",
        "a.test:99999",
        "a.test:",
        "https://a.test",
        "10.0.0.1",
      ],
    })),
    {
      name: "egress.privateHosts",
      node: (schema) => schema.properties?.egress?.properties?.privateHosts?.items,
      layer: (value) => ({ egress: { privateHosts: [value] } }),
      samples: [
        "gw.corp.test",
        "*.corp.test",
        "10.0.0.1",
        "127.0.0.1",
        "localhost",
        "db.localhost",
        "localhost.corp.test",
        "gw:443",
      ],
    },
    {
      name: "credentials.rules[].host",
      node: (schema) => schema.properties?.credentials?.properties?.rules?.items?.properties?.host,
      layer: (value) => rule({ host: value }),
      samples: [
        "api.example.test",
        "10.0.0.1",
        "1.2",
        "1x.example.test",
        "*.example.test",
        "api.example.test:443",
      ],
    },
    {
      name: "env.allow",
      node: (schema) => schema.properties?.env?.properties?.allow?.items,
      layer: (value) => ({ env: { allow: [value] } }),
      samples: [
        "TERM",
        "EDITOR",
        "LANG",
        "GITHUB_TOKEN",
        "HTTPS_PROXY",
        "https_proxy",
        "Http_Proxy",
        "NO_PROXY",
        "all_proxy",
        "NODE_USE_ENV_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "PIP_CERT",
        "BASH_ENV",
        "JAVA_TOOL_OPTIONS",
        "GITLAB_HOST",
        "GIT_TERMINAL_PROMPT",
        "PI_SANDBOX",
        "PI_SANDBOX_LAUNCH_ID",
        "PI_CODING_AGENT_DIR",
        "HOME",
        "PATH",
        "PWD",
        "path",
        "1BAD",
      ],
    },
    {
      name: "mounts.cacheVolumes",
      node: (schema) => schema.properties?.mounts?.properties?.cacheVolumes?.items,
      layer: (value) => ({ mounts: { cacheVolumes: [value] } }),
      samples: [
        "node_modules",
        ".venv",
        "build/",
        "a/b",
        ".github/x",
        ".gitignore-cache",
        "",
        ".",
        "./",
        "..",
        "a/../b",
        "a/./b",
        "a//b",
        "/abs",
        ".git",
        "a/.git",
        "a/.git/b",
        ".GIT/hooks/pre-commit",
        "a/.Git",
        ".gitkeep-cache",
      ],
    },
    {
      name: "image.reference",
      node: (schema) => schema.properties?.image?.properties?.reference,
      layer: (value) => ({ image: { reference: value } }),
      samples: ["ghcr.io/acme/pi:1", "", "  ", " x "],
    },
  ];

  it.each(STRING_CASES)("accepts and refuses the same $name values as the validator", async (testCase) => {
    const node = testCase.node(await readSchema());

    expect(node).toBeDefined();
    expect(testCase.samples.map((value) => [value, stringAccepts(node ?? {}, value)])).toEqual(
      testCase.samples.map((value) => [value, validatorAccepts(testCase.layer(value))]),
    );
  });

  it("accepts and refuses the same file secret keys per format as the validator", async () => {
    const fileSecret = (await readSchema()).properties?.credentials?.properties?.rules?.items?.properties
      ?.secret?.oneOf?.[2];
    const keyNode = (format: string) => ({
      allOf: [
        fileSecret?.properties?.key ?? {},
        ...(fileSecret?.allOf ?? [])
          .filter(({ if: condition }) => {
            const wanted = condition?.properties?.format;

            return wanted?.const === format || (wanted?.enum ?? []).includes(format);
          })
          .map((part) => part.then?.properties?.key ?? {}),
      ],
    });
    const samples: Array<[string, string]> = [
      ["json", "/token"],
      ["json", "/hosts/[name=a]/token"],
      ["json", "token"],
      ["npmrc", "//registry.example.test/:_authToken"],
      ["npmrc", "a b"],
      ["npmrc", "a=b"],
      ["ini", "global.index-url"],
      ["ini", "global.extra-index-url[1]"],
      ["ini", "global"],
      ["ini", "a b.c"],
      ["maven-servers", "corp-releases"],
      ["maven-servers", "  "],
    ];

    expect(samples.map(([format, key]) => [format, key, stringAccepts(keyNode(format), key)])).toEqual(
      samples.map(([format, key]) => [
        format,
        key,
        validatorAccepts(rule({ secret: { file: "/x", format, key } })),
      ]),
    );
  });

  it("states the list and rule constraints a string pattern cannot", async () => {
    const schema = await readSchema();
    const rules = schema.properties?.credentials?.properties?.rules;

    expect(rules?.uniqueItems).toBe(true);
    expect(rules?.items?.dependentRequired).toEqual({ template: ["header"] });
    expect(schema.properties?.mounts?.properties?.cacheVolumes?.uniqueItems).toBe(true);
    expect(
      validatorAccepts(rule({ template: "Bearer {secret}", header: undefined, placeholder: "pi-sandbox-x" })),
    ).toBe(false);
  });
});
