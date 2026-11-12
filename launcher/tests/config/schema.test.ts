import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setPath } from "../../config/dotted.ts";
import { configKeys, validateConfig } from "../../config/validate.ts";

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
    expect(distinctSorted(schemaKeys(schema, ""))).toEqual(distinctSorted(configKeys()));
  });

  it("accepts and refuses the same shared cache paths as the validator", async () => {
    const pattern = new RegExp(
      (await readSchema()).properties?.mounts?.properties?.sharedCaches?.items?.pattern ?? "",
    );
    const accepted = (path: string) => {
      try {
        validateConfig({ mounts: { sharedCaches: [path] } });

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
      validateConfig(layer);

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
        "10.0.0.1:8443",
        "::1",
        "foo.123",
        "foo.0x1F",
        "localhost",
        "db.LocalHost:8443",
        "a.test:80",
        "a.test:8080",
        "a.test:00443",
        "a_b.Corp.test",
        "*.svc_x.test:8443",
        "-a.test",
        "a-.test",
        "a.test.",
        `${"a".repeat(63)}.test`,
        `${"a".repeat(64)}.test`,
        `${"a.".repeat(126)}b`,
        `${"a.".repeat(127)}b`,
        `*.${"a.".repeat(126)}b`,
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
        "::1",
        "gw_1.corp.test",
        "*.localhost",
        "corp.123",
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
        "localhost",
        "API_1.example.test",
        `${"a.".repeat(127)}b`,
      ],
    },
    {
      name: "credentials.derive.hosts",
      node: (schema) => schema.properties?.credentials?.properties?.derive?.properties?.hosts?.items,
      layer: (value) => ({ credentials: { derive: { hosts: [value] } } }),
      samples: ["api.example.test", "*.corp.test", "10.0.0.1", "localhost", "a.test:443", "a_b.test"],
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
        "DB_PASSWD",
        "GPG_PASSPHRASE",
        "SESSION_JWT",
        "jwt_issuer",
        "PI_SANDBOX_EXTRA",
        "GH_TOKEN",
      ],
    },
    {
      name: "image.reference",
      node: (schema) => schema.properties?.image?.properties?.reference,
      layer: (value) => ({ image: { reference: value, digest: `sha256:${"a".repeat(64)}` } }),
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
    expect(schema.properties?.mounts?.properties?.sharedCaches?.uniqueItems).toBe(true);
    expect(schema.properties?.image?.dependentRequired).toEqual({
      reference: ["digest"],
      digest: ["reference"],
    });
    expect(validatorAccepts({ image: { reference: "corp/pi:1" } })).toBe(false);
    expect(validatorAccepts({ image: { digest: `sha256:${"a".repeat(64)}` } })).toBe(false);
    expect(validatorAccepts({ mounts: { sharedCaches: ["~/.npm", "~/.npm/cache"] } })).toBe(false);
    expect(
      validatorAccepts(rule({ template: "Bearer {secret}", header: undefined, placeholder: "pi-sandbox-x" })),
    ).toBe(false);
  });
});
