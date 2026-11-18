import { describe, expect, it } from "vitest";
import {
  isToolConfigKey,
  parseIni,
  parseMavenSettings,
  parseNpmrc,
  toolConfigValue,
} from "../../shared/index.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64");

const NPMRC = [
  "; comment",
  "registry=https://registry.npmjs.org/",
  "//npm.corp.test/repo/:_authToken = corp-token",
  `//basic.corp.test/:_auth="${b64("me:basic-secret")}"`,
  "//pw.corp.test/:username=me",
  `//pw.corp.test/:_password=${b64("pw-secret")}`,
  "@corp:registry=https://npm.corp.test/repo/",
].join("\n");

const PIP = [
  "[global]",
  "index-url = https://me:pip%40secret@pypi.corp.test/simple",
  "extra-index-url =",
  "    https://pypi.org/simple",
  "    https://bot:second@extra.corp.test/simple",
  "# comment",
  "[install]",
  "timeout: 30",
].join("\n");

const SETTINGS = `<?xml version="1.0"?>
<!-- host settings -->
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <servers>
    <server>
      <id>corp</id>
      <username>me</username>
      <password>a&amp;b&lt;c</password>
    </server>
    <server><id>enc</id><username>me</username><password>{COQLCE6DU6GtcS5P=}</password></server>
    <server><id>cdata</id><password><![CDATA[x<y]]></password></server>
  </servers>
  <mirrors>
    <mirror><id>corp</id><mirrorOf>*</mirrorOf><url>https://maven.corp.test/repo</url></mirror>
  </mirrors>
  <profiles>
    <profile>
      <repositories><repository><id>extra</id><url>https://extra.corp.test/m2</url></repository></repositories>
      <pluginRepositories><pluginRepository><id>plugins</id><url>https://plugins.corp.test/</url></pluginRepository></pluginRepositories>
    </profile>
  </profiles>
</settings>
`;

describe("npmrc", () => {
  it("lists keys and values without comments or quotes", () => {
    expect(parseNpmrc(NPMRC).map((entry) => entry.key)).toEqual([
      "registry",
      "//npm.corp.test/repo/:_authToken",
      "//basic.corp.test/:_auth",
      "//pw.corp.test/:username",
      "//pw.corp.test/:_password",
      "@corp:registry",
    ]);
  });

  it("gives a token as written and the password of _auth and _password decoded", () => {
    const value = (key: string) => toolConfigValue(NPMRC, { format: "npmrc", key });

    expect(value("//npm.corp.test/repo/:_authToken")).toBe("corp-token");
    expect(value("//basic.corp.test/:_auth")).toBe("basic-secret");
    expect(value("//pw.corp.test/:_password")).toBe("pw-secret");
    expect(value("//missing.test/:_authToken")).toBeUndefined();
  });
});

describe("ini", () => {
  it("reads sections, continuation lines and both separators", () => {
    expect(parseIni(PIP)).toEqual([
      {
        name: "global",
        entries: [
          ["index-url", "https://me:pip%40secret@pypi.corp.test/simple"],
          ["extra-index-url", "https://pypi.org/simple\nhttps://bot:second@extra.corp.test/simple"],
        ],
      },
      { name: "install", entries: [["timeout", "30"]] },
    ]);
  });

  it("gives a value, a word of it, or the decoded password of a URL", () => {
    expect(toolConfigValue(PIP, { format: "ini", key: "install.timeout" })).toBe("30");
    expect(toolConfigValue(PIP, { format: "ini", key: "global.index-url", urlPassword: true })).toBe(
      "pip@secret",
    );
    expect(toolConfigValue(PIP, { format: "ini", key: "global.extra-index-url[1]", urlPassword: true })).toBe(
      "second",
    );
    expect(
      toolConfigValue(PIP, { format: "ini", key: "global.extra-index-url[0]", urlPassword: true }),
    ).toBeUndefined();
  });
});

describe("Maven settings", () => {
  it("reads servers, mirrors and profile repositories with entities and CDATA", () => {
    expect(parseMavenSettings(SETTINGS)).toEqual({
      servers: [
        { id: "corp", username: "me", password: "a&b<c" },
        { id: "enc", username: "me", password: "{COQLCE6DU6GtcS5P=}" },
        { id: "cdata", password: "x<y" },
      ],
      mirrors: [{ id: "corp", url: "https://maven.corp.test/repo", mirrorOf: "*" }],
      repositories: [
        { id: "extra", url: "https://extra.corp.test/m2" },
        { id: "plugins", url: "https://plugins.corp.test/" },
      ],
      passthrough: [expect.objectContaining({ name: "profiles" })],
    });
    expect(toolConfigValue(SETTINGS, { format: "maven-servers", key: "corp" })).toBe("a&b<c");
  });

  it("gives nothing for a document that is not well formed", () => {
    expect(parseMavenSettings("<settings><servers></settings>")).toBeUndefined();
    expect(parseMavenSettings("<other/>")).toBeUndefined();
  });
});

describe("json select", () => {
  const models = JSON.stringify({
    providers: {
      corp: {
        models: [
          { id: "first", headers: { "x-api-key": "one" } },
          { id: "a/b", headers: { "x-api-key": "two" } },
        ],
      },
    },
  });

  it("picks an array element by a field, whatever its position", () => {
    expect(
      toolConfigValue(models, { format: "json", key: "/providers/corp/models/[id=a~1b]/headers/x-api-key" }),
    ).toBe("two");
    expect(
      toolConfigValue(models, { format: "json", key: "/providers/corp/models/[id=gone]/headers/x-api-key" }),
    ).toBeUndefined();
    expect(toolConfigValue("not json", { format: "json", key: "/a" })).toBeUndefined();
  });
});

describe("isToolConfigKey", () => {
  it("accepts each format's key shape only", () => {
    expect(isToolConfigKey("json", "/a/[id=x]/b")).toBe(true);
    expect(isToolConfigKey("json", "a")).toBe(false);
    expect(isToolConfigKey("ini", "global.index-url[2]")).toBe(true);
    expect(isToolConfigKey("ini", "index-url")).toBe(false);
    expect(isToolConfigKey("npmrc", "//host/:_authToken")).toBe(true);
    expect(isToolConfigKey("maven-servers", "two words")).toBe(false);
  });
});
