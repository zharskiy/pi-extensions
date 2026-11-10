import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { deriveHostTools, deriveSandboxPi } from "../../hostpi/index.ts";
import { renderAgentDir } from "../../provision/index.ts";
import { envSecretsFor } from "../../proxy/index.ts";
import { placeholderFor, toolConfigValue } from "../../shared/index.ts";
import { createFakeRunner, type FakeResponder } from "../support/fake-runner.ts";
import { braced, tempDir, writeExecutable, writeText } from "./fixtures.ts";

const SALT = "salt-1";

const GH_TOKEN = "gho_REAL-GH-TOKEN-4711";

const GLAB_TOKEN = "glpat-REAL-GLAB-TOKEN-0815";

const P = (identity: string) => placeholderFor(SALT, identity);

const b64 = (text: string) => Buffer.from(text).toString("base64");

interface Setup {
  envFromHome?: (home: string) => Record<string, string>;
  bins?: string[];
  files?: Record<string, string>;
  env?: Record<string, string>;
  respond?: FakeResponder;
  enabled?: boolean;
  excludedRoots?: (home: string) => string[];
}

const derive = async (setup: Setup = {}) => {
  const home = await tempDir("tools-home");
  const bin = join(home, "bin");

  await Promise.all((setup.bins ?? []).map((name) => writeExecutable(join(bin, name))));

  await Promise.all(
    Object.entries(setup.files ?? {}).map(([path, text]) => writeText(join(home, path), text)),
  );

  const fake = createFakeRunner((call) => setup.respond?.(call));
  const tools = await deriveHostTools({
    home,
    env: { PATH: `/nonexistent:${bin}`, ...setup.env, ...setup.envFromHome?.(home) },
    platform: "darwin",
    runner: fake.runner,
    salt: SALT,
    enabled: setup.enabled ?? true,
    excludedRoots: setup.excludedRoots?.(home) ?? [],
  });

  return { home, bin, tools, calls: fake.calls };
};

const rulesOf = (rules: CredentialRule[], id: string) => rules.filter((rule) => rule.id === id);

const GH_HOSTS = `github.com:
    user: me
    oauth_token: ${GH_TOKEN}
    git_protocol: ssh
acme.ghe.com:
    user: me
`;

describe("gh", () => {
  it("derives a command rule per host, the API hosts and GH_TOKEN, all with placeholders", async () => {
    const { bin, tools } = await derive({
      bins: ["gh"],
      files: { ".config/gh/hosts.yml": GH_HOSTS },
    });
    const gh = join(bin, "gh");

    expect(rulesOf(tools.rules, "derived:gh:github.com:token").map((rule) => rule.host)).toEqual([
      "github.com",
      "api.github.com",
      "uploads.github.com",
    ]);
    expect(rulesOf(tools.rules, "derived:gh:acme.ghe.com:token")).toEqual([
      expect.objectContaining({ host: "acme.ghe.com" }),
      {
        id: "derived:gh:acme.ghe.com:token",
        host: "api.acme.ghe.com",
        placeholder: P("gh:acme.ghe.com:token"),
        secret: { command: [gh, "auth", "token", "--hostname", "acme.ghe.com"] },
      },
    ]);
    expect(tools.value.gh).toEqual([
      { host: "github.com", token: P("gh:github.com:token") },
      { host: "acme.ghe.com", token: P("gh:acme.ghe.com:token") },
    ]);
    expect(tools.value.env).toEqual({ GH_TOKEN: P("gh:github.com:token") });
    expect(JSON.stringify(tools)).not.toContain(GH_TOKEN);
  });

  it("reads hosts.yml from GH_CONFIG_DIR", async () => {
    const { tools } = await derive({
      bins: ["gh"],
      files: { "elsewhere/hosts.yml": "corp.example.test:\n    user: me\n" },
      env: { GH_CONFIG_DIR: "" },
    });

    expect(tools.value.gh).toEqual([]);

    const moved = await tempDir("gh-config");

    await writeText(join(moved, "hosts.yml"), "corp.example.test:\n    user: me\n");

    const configured = await derive({
      bins: ["gh"],
      env: { GH_CONFIG_DIR: moved },
    });

    expect(configured.tools.value.gh.map((entry) => entry.host)).toEqual(["corp.example.test"]);
  });

  it("derives nothing and says nothing without gh on PATH", async () => {
    const { tools, calls } = await derive({ files: { ".config/gh/hosts.yml": GH_HOSTS } });

    expect(tools.rules).toEqual([]);
    expect(tools.notices).toEqual([]);
    expect(calls.filter((call) => call.file.endsWith("gh"))).toEqual([]);
  });
});

const GLAB_CONFIG = `git_protocol: ssh
hosts:
    gitlab.com:
        token: ${GLAB_TOKEN}
        api_host: gitlab.com
        git_protocol: ssh
        api_protocol: https
        user: me
    gitlab.corp.test:
        token: ${GLAB_TOKEN}
        api_host: api.gitlab.corp.test
        is_oauth2: "true"
        oauth2_refresh_token: ${GLAB_TOKEN}
        user: me
    empty.corp.test:
        user: nobody
editor: vim
`;

const glabToken: FakeResponder = (call) => {
  if (call.args[0] !== "config") {
    return undefined;
  }

  return call.args.at(-1) === "empty.corp.test" ? { stdout: "\n" } : { stdout: `${GLAB_TOKEN}\n` };
};

describe("glab", () => {
  it("derives command rules per host with its api host and renders placeholders only", async () => {
    const { bin, tools } = await derive({
      bins: ["glab"],
      files: { "Library/Application Support/glab-cli/config.yml": GLAB_CONFIG },
      respond: glabToken,
    });
    const glab = join(bin, "glab");

    expect(rulesOf(tools.rules, "derived:glab:gitlab.corp.test:token")).toEqual(
      ["gitlab.corp.test", "api.gitlab.corp.test"].map((host) => ({
        id: "derived:glab:gitlab.corp.test:token",
        host,
        placeholder: P("glab:gitlab.corp.test:token"),
        secret: { command: [glab, "config", "get", "token", "--host", "gitlab.corp.test"] },
      })),
    );
    expect(rulesOf(tools.rules, "derived:glab:gitlab.com:token").map((rule) => rule.host)).toEqual([
      "gitlab.com",
    ]);
    expect(tools.value.glab).toEqual([
      {
        host: "gitlab.com",
        token: P("glab:gitlab.com:token"),
        user: "me",
        apiHost: "gitlab.com",
        apiProtocol: "https",
      },
      {
        host: "gitlab.corp.test",
        token: P("glab:gitlab.corp.test:token"),
        user: "oauth2",
        apiHost: "api.gitlab.corp.test",
      },
    ]);
    expect(tools.notices).toEqual([
      "glab empty.corp.test: no token on the host; run glab auth login --hostname empty.corp.test there",
    ]);
    expect(tools.value.env).toEqual({});
    expect(JSON.stringify(tools)).not.toContain(GLAB_TOKEN);
    expect(JSON.stringify(deriveSandboxPi({ ...pureInput(), tools }))).not.toContain(GLAB_TOKEN);
  });

  it("sets GITLAB_TOKEN and GITLAB_HOST only when gitlab.com is the only host", async () => {
    const { tools } = await derive({
      bins: ["glab"],
      files: { ".config/glab-cli/config.yml": `hosts:\n  gitlab.com:\n    token: ${GLAB_TOKEN}\n` },
      respond: glabToken,
    });

    expect(tools.value.env).toEqual({ GITLAB_TOKEN: P("glab:gitlab.com:token"), GITLAB_HOST: "gitlab.com" });
  });

  it("derives nothing and says nothing without glab on PATH", async () => {
    const { tools } = await derive({ files: { ".config/glab-cli/config.yml": GLAB_CONFIG } });

    expect(tools.rules).toEqual([]);
    expect(tools.notices).toEqual([]);
  });
});

const pureInput = () => ({
  files: { agentDir: "/home/user/.pi/agent" },
  providerHosts: {},
  manual: [],
  salt: SALT,
  env: {},
  derive: { enabled: true },
});

describe("npmrc", () => {
  it("keeps plain keys and turns registry credentials into placeholders with file or env secrets", async () => {
    const npmrc = [
      "registry=https://registry.npmjs.org/",
      "//npm.corp.test/repo/:_authToken=NPM-REAL-TOKEN",
      `//basic.corp.test:8443/:_auth=${b64("me:NPM-REAL-BASIC")}`,
      "//pw.corp.test/:username=me",
      `//pw.corp.test/:_password=${b64("NPM-REAL-PASSWORD")}`,
      `//env.corp.test/:_authToken=${braced("NPM_TOKEN")}`,
      "_authToken=NPM-UNSCOPED",
      "cafile=/Users/me/corp.pem",
    ].join("\n");
    const { home, tools } = await derive({ files: { ".npmrc": npmrc } });
    const file = join(home, ".npmrc");

    expect(tools.value.npmrc).toEqual([
      { key: "registry", value: "https://registry.npmjs.org/" },
      { key: "//npm.corp.test/repo/:_authToken", value: P("npmrc:npm.corp.test/repo/:_authToken") },
      { key: "//basic.corp.test:8443/:_auth", value: b64(`me:${P("npmrc:basic.corp.test:8443/:_auth")}`) },
      { key: "//pw.corp.test/:username", value: "me" },
      { key: "//pw.corp.test/:_password", value: b64(P("npmrc:pw.corp.test/:_password")) },
      { key: "//env.corp.test/:_authToken", value: P("npmrc:env.corp.test/:_authToken") },
    ]);
    expect(tools.rules).toEqual([
      {
        id: "derived:npmrc:npm.corp.test/repo/:_authToken",
        host: "npm.corp.test",
        pathPrefix: "/repo",
        placeholder: P("npmrc:npm.corp.test/repo/:_authToken"),
        secret: { file, format: "npmrc", key: "//npm.corp.test/repo/:_authToken" },
      },
      expect.objectContaining({ host: "basic.corp.test", port: 8443 }),
      expect.objectContaining({ host: "pw.corp.test" }),
      expect.objectContaining({ host: "env.corp.test", secret: { env: "NPM_TOKEN" } }),
    ]);
    expect(tools.notices).toEqual([
      "npmrc: _authToken has no registry; scope it as //<registry host>/:_authtoken to use it in the sandbox",
      "npmrc: cafile stays on the host; add the CA to tls.extraCa so the sandbox trusts it",
    ]);
    expect(JSON.stringify(tools)).not.toMatch(/NPM-REAL|NPM-UNSCOPED/);
  });
});

describe("npmrc host paths and registries", () => {
  it("keeps keys that name host paths on the host and lists the registries for the egress notice", async () => {
    const npmrc = [
      `prefix=${braced("HOME")}/.npm-global`,
      "cache=/Users/me/.npm",
      "script-shell=/opt/homebrew/bin/bash",
      "logfile=/tmp/npm.log",
      "registry=https://npm.corp.test/",
      "@acme:registry=https://acme.corp.test:8443/npm/",
      "save-exact=true",
    ].join("\n");
    const { tools } = await derive({
      files: { ".npmrc": npmrc, ".m2/settings.xml": MAVEN_SETTINGS },
      env: { HOME: "/Users/me" },
    });

    expect(tools.value.npmrc).toEqual([
      { key: "registry", value: "https://npm.corp.test/" },
      { key: "@acme:registry", value: "https://acme.corp.test:8443/npm/" },
      { key: "save-exact", value: "true" },
    ]);
    expect(tools.notices).toEqual(
      expect.arrayContaining([
        "npmrc: prefix names a host path and stays on the host",
        "npmrc: cache names a host path and stays on the host",
        "npmrc: script-shell names a host path and stays on the host",
        "npmrc: logfile names a host path and stays on the host",
      ]),
    );
    expect(tools.registries).toEqual(
      expect.arrayContaining([
        { label: "npmrc", endpoint: { host: "npm.corp.test" } },
        { label: "npmrc", endpoint: { host: "acme.corp.test", port: 8443 } },
        { label: "maven", endpoint: { host: "maven.corp.test" } },
        { label: "maven", endpoint: { host: "plugins.corp.test" } },
      ]),
    );
  });
});

describe("Maven settings", () => {
  it("merges servers with placeholder passwords and copies mirrors; encrypted and hostless servers stay out", async () => {
    const settings = `<settings>
  <servers>
    <server><id>corp</id><username>me</username><password>M2-REAL-SECRET</password></server>
    <server><id>enc</id><username>me</username><password>{COQLCE6DU6GtcS5P=}</password></server>
    <server><id>lonely</id><username>me</username><password>M2-REAL-LONELY</password></server>
    <server><id>extra</id><password>\${env.M2_EXTRA}</password></server>
  </servers>
  <mirrors><mirror><id>corp</id><mirrorOf>*</mirrorOf><url>https://maven.corp.test/repo</url></mirror></mirrors>
  <profiles><profile><repositories>
    <repository><id>extra</id><url>https://extra.corp.test/m2</url></repository>
  </repositories></profile></profiles>
</settings>`;
    const { home, tools } = await derive({ files: { ".m2/settings.xml": settings } });

    expect(tools.value.maven).toEqual({
      servers: [
        { id: "corp", username: "me", password: P("maven:corp:password") },
        { id: "extra", password: P("maven:extra:password") },
      ],
      mirrors: [{ id: "corp", url: "https://maven.corp.test/repo", mirrorOf: "*" }],
      passthrough: [expect.objectContaining({ name: "profiles" })],
    });
    expect(tools.rules).toEqual([
      {
        id: "derived:maven:corp:password",
        host: "maven.corp.test",
        placeholder: P("maven:corp:password"),
        secret: { file: join(home, ".m2", "settings.xml"), format: "maven-servers", key: "corp" },
      },
      expect.objectContaining({ host: "extra.corp.test", secret: { env: "M2_EXTRA" } }),
    ]);
    expect(tools.notices).toEqual([
      "maven enc: the password is encrypted with settings-security.xml and stays on the host",
      "maven lonely: no mirror or profile repository with this id has an https URL; add a credentials.rules entry for its host",
    ]);
    expect(JSON.stringify(tools)).not.toContain("M2-REAL");
  });
});

describe("pip", () => {
  it("puts placeholders in index URL passwords and ignores PIP_INDEX_URL", async () => {
    const conf = [
      "[global]",
      "index-url = https://me:PIP-REAL-FILE@pypi.corp.test/simple",
      "extra-index-url =",
      "    https://pypi.org/simple",
      "    https://bot:PIP-REAL-EXTRA@extra.corp.test/simple",
      "timeout = 30",
    ].join("\n");
    const { home, tools } = await derive({
      files: { ".config/pip/pip.conf": conf },
      env: { PIP_INDEX_URL: "https://env:PIP-REAL-ENV@pypi.env.test/simple" },
    });

    expect(tools.value.pip).toEqual([
      {
        name: "global",
        entries: [
          ["index-url", `https://me:${P("pip:global.index-url[0]")}@pypi.corp.test/simple`],
          [
            "extra-index-url",
            `https://pypi.org/simple\nhttps://bot:${P("pip:global.extra-index-url[1]")}@extra.corp.test/simple`,
          ],
          ["timeout", "30"],
        ],
      },
    ]);
    expect(tools.rules.map((rule) => [rule.host, rule.secret])).toEqual([
      [
        "pypi.corp.test",
        {
          file: join(home, ".config", "pip", "pip.conf"),
          format: "ini",
          key: "global.index-url[0]",
          urlPassword: true,
        },
      ],
      [
        "extra.corp.test",
        {
          file: join(home, ".config", "pip", "pip.conf"),
          format: "ini",
          key: "global.extra-index-url[1]",
          urlPassword: true,
        },
      ],
    ]);
    expect(JSON.stringify(tools)).not.toContain("PIP-REAL");
  });
});

describe("pip config locations", () => {
  const indexOf = (url: string) => ["[global]", `index-url = ${url}`].join("\n");

  it.each([
    [".pip/pip.conf", {}],
    ["Library/Application Support/pip/pip.conf", {}],
  ])("reads %s", async (path, env) => {
    const { tools } = await derive({ files: { [path]: indexOf("https://pypi.corp.test/simple") }, env });

    expect(tools.value.pip).toEqual([
      { name: "global", entries: [["index-url", "https://pypi.corp.test/simple"]] },
    ]);
  });
});

const URL_SECRETS = {
  registry: "NPM-REG-PW-11",
  scoped: "NPM-SCOPED-PW-12",
  userOnly: "NPM-USER-TOKEN-13",
  npmProxy: "NPM-PROXY-PW-14",
  index: "PIP-INDEX-PW-21",
  extra: "PIP-EXTRA-TOKEN-22",
  pipProxy: "PIP-PROXY-PW-23",
  findLinks: "PIP-LINKS-PW-24",
};

const URL_NPMRC = [
  `registry=https://npmuser:${URL_SECRETS.registry}@npm.corp.test/repo/`,
  `@corp:registry=https://bot:${URL_SECRETS.scoped}@scoped.corp.test/`,
  `@fury:registry=https://${URL_SECRETS.userOnly}@npm.fury.test/me/`,
  `https-proxy=http://puser:${URL_SECRETS.npmProxy}@proxy.corp.test:3128`,
  "proxy=http://proxy.corp.test:3128",
].join("\n");

const URL_PIP = [
  "[global]",
  `index-url = https://me:${URL_SECRETS.index}@pypi.corp.test/simple`,
  "extra-index-url =",
  `    https://${URL_SECRETS.extra}@pypi.fury.test/me/simple`,
  `proxy = http://puser:${URL_SECRETS.pipProxy}@proxy.corp.test:3128`,
  `find-links = https://me:${URL_SECRETS.findLinks}@links.corp.test/`,
  "trusted-host = pypi.corp.test",
].join("\n");

const treeText = async (dir: string): Promise<string> => {
  const names = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(
    names
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );

  return texts.join("\n");
};

const resolvedOn = async (rules: CredentialRule[], host: string, env: Record<string, string>) => {
  const rule = rules.find((entry) => entry.host === host);
  const secret = rule?.secret;

  if (rule === undefined || secret === undefined || !("file" in secret) || !("format" in secret)) {
    return rule === undefined ? undefined : envSecretsFor([rule], env)[rule.id];
  }

  return toolConfigValue(await readFile(secret.file, "utf8"), secret);
};

describe("URL userinfo in npmrc and pip.conf", () => {
  it("renders placeholders for every userinfo form, keeps the secrets on the host and binds each to its host", async () => {
    const env = {};
    const { home, tools } = await derive({
      files: { ".npmrc": URL_NPMRC, ".config/pip/pip.conf": URL_PIP },
    });
    const sandbox = deriveSandboxPi({ ...pureInput(), tools });
    const stateDir = await tempDir("tools-render");
    const { renderDir } = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: join(home, "agent"),
      derived: sandbox,
    });
    const rendered = await treeText(renderDir);
    const leaked = Object.values(URL_SECRETS).filter(
      (secret) => JSON.stringify(sandbox).includes(secret) || rendered.includes(secret),
    );

    expect(leaked).toEqual([]);
    expect(tools.value.npmrc).toEqual([
      { key: "registry", value: `https://npmuser:${P("npmrc:registry:url")}@npm.corp.test/repo/` },
      { key: "@corp:registry", value: `https://bot:${P("npmrc:@corp:registry:url")}@scoped.corp.test/` },
      { key: "@fury:registry", value: `https://${P("npmrc:@fury:registry:url")}@npm.fury.test/me/` },
    ]);
    expect(tools.value.pip).toEqual([
      {
        name: "global",
        entries: [
          ["index-url", `https://me:${P("pip:global.index-url[0]")}@pypi.corp.test/simple`],
          ["extra-index-url", `https://${P("pip:global.extra-index-url[0]")}@pypi.fury.test/me/simple`],
          ["trusted-host", "pypi.corp.test"],
        ],
      },
    ]);
    expect(
      tools.rules.map((rule) => ({
        host: rule.host,
        pathPrefix: rule.pathPrefix,
        placeholder: rule.placeholder,
      })),
    ).toEqual([
      { host: "npm.corp.test", pathPrefix: "/repo", placeholder: P("npmrc:registry:url") },
      { host: "scoped.corp.test", pathPrefix: undefined, placeholder: P("npmrc:@corp:registry:url") },
      { host: "npm.fury.test", pathPrefix: "/me", placeholder: P("npmrc:@fury:registry:url") },
      { host: "pypi.corp.test", pathPrefix: undefined, placeholder: P("pip:global.index-url[0]") },
      { host: "pypi.fury.test", pathPrefix: undefined, placeholder: P("pip:global.extra-index-url[0]") },
    ]);
    expect(
      await Promise.all(
        ["npm.corp.test", "scoped.corp.test", "npm.fury.test", "pypi.corp.test", "pypi.fury.test"].map(
          (host) => resolvedOn(tools.rules, host, env),
        ),
      ),
    ).toEqual([
      URL_SECRETS.registry,
      URL_SECRETS.scoped,
      URL_SECRETS.userOnly,
      URL_SECRETS.index,
      URL_SECRETS.extra,
    ]);
    expect(tools.notices).toEqual([
      "npmrc: https-proxy stays on the host; the sandbox reaches the network through the launcher proxy",
      "npmrc: proxy stays on the host; the sandbox reaches the network through the launcher proxy",
      "pip: global.proxy stays on the host; the sandbox reaches the network through the launcher proxy",
      "pip: global.find-links carries credentials in a URL and stays on the host",
    ]);
    expect(rendered).toContain(`registry=https://npmuser:${P("npmrc:registry:url")}@npm.corp.test/repo/`);
    expect(rendered).toContain(`https://${P("pip:global.extra-index-url[0]")}@pypi.fury.test/me/simple`);
  });

  it("keeps a registry URL out when its credentials come through an environment variable", async () => {
    const { tools } = await derive({
      files: { ".npmrc": `registry=https://me:${braced("NPM_PW")}@npm.corp.test/\n` },
      env: { NPM_PW: "NPM-VAR-PW" },
    });

    expect(tools.value.npmrc).toEqual([]);
    expect(tools.rules).toEqual([]);
    expect(tools.notices).toEqual(["npmrc: registry carries credentials in a URL and stays on the host"]);
  });

  it("strips userinfo from a Maven mirror URL and points at a server entry", async () => {
    const settings = `<settings><mirrors><mirror><id>nexus</id><mirrorOf>*</mirrorOf><url>https://me:M2-MIRROR-PW@nexus.corp.test/repo</url></mirror></mirrors></settings>`;
    const { tools } = await derive({ files: { ".m2/settings.xml": settings } });

    expect(tools.value.maven.mirrors).toEqual([
      { id: "nexus", mirrorOf: "*", url: "https://nexus.corp.test/repo" },
    ]);
    expect(JSON.stringify(tools)).not.toContain("M2-MIRROR-PW");
    expect(tools.notices).toEqual([
      "maven nexus: the mirror URL carried user credentials; they stay on the host, put them in a <server> with id nexus",
    ]);
  });
});

describe("git identity and the derive switch", () => {
  it("reads the host user name and email, also with derivation off", async () => {
    const { bin, tools, calls } = await derive({
      bins: ["gh", "git"],
      files: { ".config/gh/hosts.yml": GH_HOSTS, ".npmrc": "//npm.test/:_authToken=x\n" },
      enabled: false,
      respond: (call) =>
        call.file.endsWith("/git") ? { stdout: "user.name Max Z\nuser.email max@corp.test\n" } : undefined,
    });

    expect(tools.value.git).toEqual({ name: "Max Z", email: "max@corp.test" });
    expect(tools.rules).toEqual([]);
    expect(tools.value.gh).toEqual([]);
    expect(tools.value.npmrc).toBeUndefined();
    expect(calls.map((call) => call.file)).toEqual([join(bin, "git")]);
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
    ]);
  });
});

const MAVEN_SETTINGS = `<settings>
  <localRepository>/Users/me/m2repo</localRepository>
  <servers>
    <server><id>corp</id><username>me</username><password>M2-REAL-PASSWORD</password></server>
    <server>
      <id>gitlab</id>
      <configuration>
        <timeout>30000</timeout>
        <httpHeaders><property><name>Private-Token</name><value>GL-REAL-TOKEN</value></property></httpHeaders>
      </configuration>
    </server>
    <server><id>deploy</id><username>ci</username><configuration><timeout>5000</timeout></configuration></server>
    <server><id>ssh</id><username>git</username><privateKey>/Users/me/.ssh/id_ed25519</privateKey></server>
  </servers>
  <mirrors><mirror><id>corp</id><mirrorOf>central</mirrorOf><url>https://maven.corp.test/repo</url></mirror></mirrors>
  <profiles>
    <profile>
      <id>corp</id>
      <activation><activeByDefault>true</activeByDefault></activation>
      <properties><java.version>17</java.version><deploy.password>M2-REAL-PROPERTY</deploy.password><sonar.login>squ_M2-REAL-SONAR</sonar.login></properties>
      <repositories><repository><id>gitlab</id><url>https://gitlab.corp.test/api/v4/packages/maven</url></repository></repositories>
      <pluginRepositories><pluginRepository><id>plugins</id><url>https://bob:M2-REAL-URL@plugins.corp.test/m2</url></pluginRepository></pluginRepositories>
    </profile>
  </profiles>
  <activeProfiles><activeProfile>corp</activeProfile></activeProfiles>
  <pluginGroups><pluginGroup>org.sonarsource.scanner.maven</pluginGroup></pluginGroups>
</settings>`;

describe("Maven settings in the sandbox", () => {
  const renderedMaven = async () => {
    const { home, tools } = await derive({ files: { ".m2/settings.xml": MAVEN_SETTINGS } });
    const sandbox = deriveSandboxPi({ ...pureInput(), tools });
    const { renderDir } = await renderAgentDir({
      stateDir: await tempDir("maven-render"),
      repoHash: "repo1",
      hostAgentDir: join(home, "agent"),
      derived: sandbox,
    });

    return { tools, rendered: await treeText(renderDir) };
  };

  it("copies each profile's id, activation and repositories, activeProfiles, pluginGroups and the mirrors, and no profile properties", async () => {
    const { rendered } = await renderedMaven();

    expect(rendered).toContain("<activeProfile>corp</activeProfile>");
    expect(rendered).toContain("<pluginGroup>org.sonarsource.scanner.maven</pluginGroup>");
    expect(rendered).toContain("<activeByDefault>true</activeByDefault>");
    expect(rendered).not.toMatch(/properties|java\.version|sonar\.login/);
    expect(rendered).toContain("<url>https://gitlab.corp.test/api/v4/packages/maven</url>");
    expect(rendered).toContain("<url>https://plugins.corp.test/m2</url>");
    expect(rendered).toContain("<mirrorOf>central</mirrorOf>");
    expect(rendered).not.toContain("localRepository");
    expect(rendered).not.toMatch(/M2-REAL|GL-REAL|deploy\.password/);
  });

  it("turns httpHeaders values into placeholders bound to the header and passes a server without credentials through", async () => {
    const { tools, rendered } = await renderedMaven();
    const header = tools.rules.find((rule) => rule.id === "derived:maven:gitlab:header:Private-Token");

    expect(rendered).toContain(
      `<name>Private-Token</name>\n            <value>${P("maven:gitlab:header:Private-Token")}</value>`,
    );
    expect(rendered).toContain("<timeout>30000</timeout>");
    expect(rendered).toMatch(
      /<id>deploy<\/id>\s*<username>ci<\/username>\s*<configuration>\s*<timeout>5000<\/timeout>/,
    );
    expect(rendered).not.toContain("<id>ssh</id>");
    expect(header).toMatchObject({ host: "gitlab.corp.test", header: "Private-Token" });
    expect(await resolvedOn(header === undefined ? [] : [header], "gitlab.corp.test", {})).toBe(
      "GL-REAL-TOKEN",
    );
  });

  it("says what stays on the host", async () => {
    const { tools } = await renderedMaven();

    expect(tools.notices).toEqual([
      "maven ssh: a privateKey or passphrase stays on the host",
      "maven profiles: a repository URL carried user credentials; they stay on the host, put them in a <server> with its id",
      "maven: localRepository /Users/me/m2repo is not used in the sandbox; Maven there uses ~/.m2/repository",
    ]);
  });
});

describe("host tools inside the sandbox roots", () => {
  it("never runs a gh or git that lies inside the sandbox", async () => {
    const { tools, calls } = await derive({
      bins: ["gh", "git"],
      files: { ".config/gh/hosts.yml": GH_HOSTS },
      excludedRoots: (home) => [join(home, "bin")],
    });

    expect(calls).toEqual([]);
    expect(tools.rules).toEqual([]);
    expect(tools.value.git).toEqual({});
  });

  it("ignores tool config files the environment points inside the sandbox", async () => {
    const { home, tools, calls } = await derive({
      bins: ["gh", "glab"],
      files: {
        "repo/gh/hosts.yml": "exfil-gh.example:\n    user: me\n",
        "repo/glab/config.yml": "hosts:\n    exfil-glab.example:\n        token: x\n",
      },
      envFromHome: (dir) => ({
        GH_CONFIG_DIR: join(dir, "repo", "gh"),
        GLAB_CONFIG_DIR: join(dir, "repo", "glab"),
      }),
      excludedRoots: (dir) => [join(dir, "repo")],
      respond: glabToken,
    });

    expect(tools.rules).toEqual([]);
    expect(tools.value.pip).toBeUndefined();
    expect(calls.filter((call) => !call.file.endsWith("/git"))).toEqual([]);
    expect(tools.notices).toEqual([
      `gh: ${join(home, "repo", "gh", "hosts.yml")} (from GH_CONFIG_DIR) lies inside the sandbox, which can rewrite it; ignored`,
      `glab: ${join(home, "repo", "glab", "config.yml")} (from GLAB_CONFIG_DIR) lies inside the sandbox, which can rewrite it; ignored`,
    ]);
  });
});

describe("host tool probes", () => {
  it("asks glab only for hosts whose token is not in its config, with a timeout", async () => {
    const { calls } = await derive({
      bins: ["glab"],
      files: { "Library/Application Support/glab-cli/config.yml": GLAB_CONFIG },
      respond: glabToken,
    });
    const probes = calls.filter((call) => call.file.endsWith("glab"));

    expect(probes.map((call) => call.args.at(-1))).toEqual(["empty.corp.test"]);
    expect(probes[0]?.options.timeoutMs).toBe(30_000);
  });

  it("skips glab and git with a notice when they do not answer in time; gh needs no probe", async () => {
    const { bin, tools } = await derive({
      bins: ["gh", "glab", "git"],
      files: {
        ".config/gh/hosts.yml": GH_HOSTS,
        ".config/glab-cli/config.yml": "hosts:\n    gitlab.corp.test:\n        user: me\n",
      },
      respond: () => ({ code: 124, timedOut: true }),
    });

    expect(tools.rules.every((rule) => rule.id.startsWith("derived:gh:"))).toBe(true);
    expect(tools.value.git).toEqual({});
    expect(tools.notices).toEqual([
      `git: ${join(bin, "git")} config --global did not answer within 10 s on the host; skipped`,
      `glab gitlab.corp.test: ${join(bin, "glab")} config get token did not answer within 30 s on the host (a Keychain prompt may be waiting); it has no credentials in the sandbox this launch, run pi again once it answers`,
    ]);
  });
});

describe("tool config details", () => {
  it("normalises pip option names as pip does", async () => {
    const { tools } = await derive({
      files: {
        ".config/pip/pip.conf":
          "[global]\nindex_url = https://me:PIP-REAL@pypi.corp.test/simple\n--proxy = http://corp:3128\n",
      },
    });

    expect(tools.value.pip).toEqual([
      {
        name: "global",
        entries: [["index_url", `https://me:${P("pip:global.index_url[0]")}@pypi.corp.test/simple`]],
      },
    ]);
    expect(tools.rules.map((rule) => rule.host)).toEqual(["pypi.corp.test"]);
    expect(tools.notices).toEqual([
      "pip: global.--proxy stays on the host; the sandbox reaches the network through the launcher proxy",
    ]);
  });

  it("keeps an npm token for a registry the sandbox cannot reach on the host", async () => {
    const { tools } = await derive({ files: { ".npmrc": "//localhost:4873/:_authToken=NPM-REAL\n" } });

    expect(tools.rules).toEqual([]);
    expect(tools.value.npmrc).toEqual([]);
    expect(tools.notices).toEqual([
      "npmrc: //localhost:4873/:_authToken names a registry the sandbox cannot reach; the key stays on the host",
    ]);
  });

  it("expands env usernames and keeps mixed env passwords on the host in Maven settings", async () => {
    const settings = `<settings>
  <servers>
    <server><id>corp</id><username>${braced("env.MVN_USER")}</username><password>${braced("env.MVN_PASS")}</password></server>
    <server><id>mixed</id><username>me</username><password>pre${braced("env.MVN_PASS")}</password></server>
    <server><id>unset</id><username>${braced("env.NOT_SET")}</username><password>M2-REAL</password></server>
  </servers>
  <mirrors>
    <mirror><id>corp</id><mirrorOf>central</mirrorOf><url>https://maven.corp.test/repo</url></mirror>
    <mirror><id>mixed</id><mirrorOf>other</mirrorOf><url>https://mixed.corp.test/repo</url></mirror>
    <mirror><id>unset</id><mirrorOf>third</mirrorOf><url>https://unset.corp.test/repo</url></mirror>
  </mirrors>
</settings>`;
    const { tools } = await derive({ files: { ".m2/settings.xml": settings }, env: { MVN_USER: "ci-user" } });

    expect(tools.value.maven.servers.map((server) => [server.id, server.username])).toEqual([
      ["corp", "ci-user"],
      ["unset", braced("env.NOT_SET")],
    ]);
    expect(rulesOf(tools.rules, "derived:maven:corp:password")[0]?.secret).toEqual({ env: "MVN_PASS" });
    expect(tools.notices).toEqual([
      `maven mixed: the password mixes ${braced("env.…")} with other text and stays on the host`,
      "maven unset: the username reads an environment variable that is unset or secret on the host; it is copied unexpanded",
    ]);
  });
});
