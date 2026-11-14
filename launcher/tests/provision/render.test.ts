import { chmod, lstat, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DerivedSandboxPi, DerivedTools } from "../../hostpi/index.ts";
import { renderAgentDir } from "../../provision/index.ts";
import { stateLayout } from "../../shared/index.ts";
import { tempDir, writeText } from "./fixtures.ts";

const NO_TOOLS: DerivedTools = {
  gh: [],
  glab: [],
  maven: { servers: [], mirrors: [], passthrough: [] },
  git: {},
  env: {},
};

const derived = (
  key = "pi-sandbox-aaaaaaaaaaaaaaaaaaaaaaaa",
  tools: Partial<DerivedTools> = {},
): DerivedSandboxPi => ({
  rules: [],
  hosts: [],
  files: {
    "auth.json": { corp: { type: "api_key", key } },
    "models.json": { providers: {} },
    "mcp.json": { mcpServers: {} },
  },
  tools: { ...NO_TOOLS, ...tools },
  oauthServers: [],
  notices: [],
});

const listTree = async (dir: string, prefix = ""): Promise<string[]> => {
  const names = (await readdir(join(dir, prefix))).sort();
  const nested = await Promise.all(
    names.map(async (name) => {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const info = await lstat(join(dir, path));

      return info.isDirectory() ? [`${path}/`, ...(await listTree(dir, path))] : [path];
    }),
  );

  return nested.flat();
};

const hostAgentDir = async () => {
  const dir = await tempDir("render-host");

  await writeText(join(dir, "agents", "reviewer.md"), "# reviewer\n");

  await writeText(join(dir, "skills", "deploy", "SKILL.md"), "deploy\n");

  await writeText(join(dir, "skills", "deploy", "run.sh"), "#!/bin/sh\n");

  await chmod(join(dir, "skills", "deploy", "run.sh"), 0o755);

  await writeText(join(dir, "skills", "deploy", ".env"), "TOKEN=SECRET-DOTENV\n");

  await writeText(join(dir, "skills", "deploy", "api-token.json"), "{}");

  await writeText(join(dir, "skills", "deploy", "client.pem"), "-----BEGIN-----");

  await writeText(join(dir, "extensions", "tool", "tokenizer.js"), "export {};\n");

  await writeText(join(dir, "extensions", "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));

  await writeText(join(dir, "keybindings.json"), "{}\n");

  await writeText(join(dir, "AGENTS.md"), "rules\n");

  await writeText(join(dir, "auth.json"), '{"real":"SECRET"}');

  await writeText(join(dir, "sessions", "one.jsonl"), "{}\n");

  await writeText(join(dir, "outside", "secret.md"), "SECRET-OUTSIDE\n");

  await symlink(join(dir, "outside"), join(dir, "prompts"));

  await symlink(join(dir, "outside", "secret.md"), join(dir, "agents", "linked.md"));

  return dir;
};

describe("renderAgentDir", () => {
  it("writes the rendered pi files and a filtered copy of the host entries", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();
    const result = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });

    expect(result.renderDir).toBe(stateLayout(stateDir).repo("repo1").render);
    expect(await listTree(result.renderDir)).toEqual([
      "AGENTS.md",
      "agents/",
      "agents/reviewer.md",
      "auth.json",
      "extensions/",
      "extensions/tool/",
      "extensions/tool/tokenizer.js",
      "keybindings.json",
      "mcp.json",
      "models.json",
      "skills/",
      "skills/deploy/",
      "skills/deploy/SKILL.md",
      "skills/deploy/run.sh",
      "tools/",
      "tools/m2-settings.xml",
    ]);
    expect(JSON.parse(await readFile(join(result.renderDir, "auth.json"), "utf8"))).toEqual(
      derived().files["auth.json"],
    );
    await expect(lstat(join(result.renderDir, "mcp-auth.json"))).rejects.toThrow();
    expect((await lstat(join(result.renderDir, "skills", "deploy", "run.sh"))).mode & 0o777).toBe(0o755);
  });

  it("rewrites only the files whose content changed", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();
    const render = (key?: string) =>
      renderAgentDir({ stateDir, repoHash: "repo1", hostAgentDir: host, derived: derived(key) });
    const first = await render();
    const auth = join(first.renderDir, "auth.json");
    const agents = join(first.renderDir, "AGENTS.md");
    const before = await stat(auth);

    await render();

    expect((await stat(auth)).ino).toBe(before.ino);

    await writeText(join(host, "AGENTS.md"), "changed\n");

    await render("pi-sandbox-bbbbbbbbbbbbbbbbbbbbbbbb");

    expect(await readFile(agents, "utf8")).toBe("changed\n");
    expect(JSON.parse(await readFile(auth, "utf8"))).toEqual(
      derived("pi-sandbox-bbbbbbbbbbbbbbbbbbbbbbbb").files["auth.json"],
    );
    expect((await stat(auth)).ino).not.toBe(before.ino);
  });

  it("rewrites a file of the same size whose bytes differ", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();
    const result = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });

    await writeText(join(result.renderDir, "AGENTS.md"), "RULES\n");

    await renderAgentDir({ stateDir, repoHash: "repo1", hostAgentDir: host, derived: derived() });

    expect(await readFile(join(result.renderDir, "AGENTS.md"), "utf8")).toBe("rules\n");
  });

  it("removes entries that are gone on the host", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();

    await renderAgentDir({ stateDir, repoHash: "repo1", hostAgentDir: host, derived: derived() });

    await rm(join(host, "skills"), { recursive: true });

    await rm(join(host, "agents", "reviewer.md"));

    const result = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });
    const tree = await listTree(result.renderDir);

    expect(tree.filter((path) => path.startsWith("skills") || path.startsWith("agents"))).toEqual([]);
  });

  it("works with an empty host agent dir", async () => {
    const stateDir = await tempDir("render-state");
    const host = await tempDir("render-host");
    const result = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });

    expect(await listTree(result.renderDir)).toEqual([
      "auth.json",
      "mcp.json",
      "models.json",
      "tools/",
      "tools/m2-settings.xml",
    ]);
  });

  it("renders Maven settings with the sandbox proxy read from the env when the host has no settings.xml", async () => {
    const stateDir = await tempDir("render-state");
    const host = await tempDir("render-host");
    const result = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });
    const settings = await readFile(join(result.renderDir, "tools", "m2-settings.xml"), "utf8");
    const proxy = /<proxy>([\s\S]*)<\/proxy>/.exec(settings)?.[1] ?? "";

    expect(proxy).toContain("<active>true</active>");
    expect(proxy).toContain(`<host>\${env.PI_SANDBOX_PROXY_HOST}</host>`);
    expect(proxy).toContain(`<port>\${env.PI_SANDBOX_PROXY_PORT}</port>`);
    expect(proxy).toContain("<username>pi-sandbox</username>");
    expect(proxy).toContain(`<password>\${env.PI_SANDBOX_PROXY_TOKEN}</password>`);
  });

  it("renders the tool files of the derived gh, glab, npm, pip, Maven and git settings", async () => {
    const stateDir = await tempDir("render-state");
    const host = await tempDir("render-host");
    const P = "pi-sandbox-bbbbbbbbbbbbbbbbbbbbbbbb";
    const result = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(undefined, {
        gh: [{ host: "github.com", token: P }],
        glab: [{ host: "gitlab.corp.test", token: P, user: "me", apiHost: "api.gitlab.corp.test" }],
        npmrc: [{ key: "//npm.corp.test/:_authToken", value: P }],
        pip: [{ name: "global", entries: [["index-url", `https://me:${P}@pypi.corp.test/simple`]] }],
        maven: {
          servers: [{ id: "corp", username: "me", password: P }],
          mirrors: [{ id: "corp", url: "https://maven.corp.test/repo", mirrorOf: "*" }],
          passthrough: [],
        },
        git: { name: 'Max "Z"', email: "max@corp.test" },
      }),
    });
    const read = (name: string) => readFile(join(result.renderDir, "tools", name), "utf8");

    expect(await read("gh-hosts.yml")).toBe(
      `github.com:\n    oauth_token: "${P}"\n    git_protocol: "https"\n`,
    );
    expect(await read("glab-config.yml")).toContain(
      `hosts:\n    gitlab.corp.test:\n        token: "${P}"\n        user: "me"\n        api_host: "api.gitlab.corp.test"\n        git_protocol: "https"\n        use_keyring: "false"\n`,
    );
    expect(await read("npmrc")).toBe(`//npm.corp.test/:_authToken=${P}\n`);
    expect(await read("pip.conf")).toBe(`[global]\nindex-url = https://me:${P}@pypi.corp.test/simple\n`);
    expect(await read("m2-settings.xml")).toMatch(
      new RegExp(
        `<proxy>[\\s\\S]*<servers>[\\s\\S]*<password>${P}</password>[\\s\\S]*<mirrorOf>\\*</mirrorOf>`,
      ),
    );
    expect(await read("gitconfig")).toBe(
      [
        "[user]",
        '\tname = "Max \\"Z\\""',
        '\temail = "max@corp.test"',
        '[credential "https://github.com"]',
        '\thelper = ""',
        '\thelper = "!gh auth git-credential"',
        '[url "https://github.com/"]',
        '\tinsteadOf = "git@github.com:"',
        '\tinsteadOf = "ssh://git@github.com/"',
        '[credential "https://gitlab.corp.test"]',
        '\thelper = ""',
        '\thelper = "!glab auth git-credential"',
        '[url "https://gitlab.corp.test/"]',
        '\tinsteadOf = "git@gitlab.corp.test:"',
        '\tinsteadOf = "ssh://git@gitlab.corp.test/"',
        "",
      ].join("\n"),
    );
  });

  it("leaves out git dirs, key files, credential files and secret-named files of any extension", async () => {
    const stateDir = await tempDir("render-state");
    const host = await tempDir("render-host");
    const skill = join(host, "skills", "deploy");
    const kept = ["SKILL.md", "tokens.ts", "public.crt"];
    const skipped = [
      ".git/config",
      ".git/HEAD",
      ".env.local",
      ".netrc",
      ".npmrc",
      ".git-credentials",
      "id_ed25519",
      "id_rsa.pub",
      "server.pem",
      "server.key",
      "store.p12",
      "store.pfx",
      "store.jks",
      "app.keystore",
      "bundle.crt",
      "api-token",
      "client_secret.bin",
      "password.lst",
    ];

    await Promise.all(
      [...kept, ...skipped].map((name) =>
        writeText(
          join(skill, name),
          name === "bundle.crt"
            ? "-----BEGIN CERTIFICATE-----\n-----BEGIN RSA PRIVATE KEY-----\nSECRET\n"
            : `${name}\n`,
        ),
      ),
    );

    const result = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });
    const files = await listTree(result.renderDir);

    expect(files.filter((path) => path.startsWith("skills/deploy/") && !path.endsWith("/")).sort()).toEqual(
      kept.map((name) => `skills/deploy/${name}`).sort(),
    );
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatch(/^render: left out of the sandbox: /);
    expect(result.notices[0]).toContain("skills/deploy/password.lst (secret-looking name)");
    expect(result.notices[0]).toContain("skills/deploy/bundle.crt (private key)");
    expect(result.notices[0]).not.toContain(".git/");
  });
});

describe("renderAgentDir fix round", () => {
  it("leaves out only directories named secrets or credentials, outside node_modules, with a notice", async () => {
    const host = await tempDir("render-host");
    const stateDir = await tempDir("render-state");
    const kept = [
      "extensions/x/node_modules/js-tokens/index.js",
      "extensions/x/node_modules/@aws-sdk/credential-providers/index.js",
      "extensions/x/node_modules/pkg/secrets/index.js",
      "extensions/x/api-tokens/a.js",
      "skills/secret-scanner/SKILL.md",
      "skills/design-tokens/SKILL.md",
    ];
    const dropped = ["extensions/x/secrets/config.json", "skills/deploy/.credentials/prod.json"];

    await Promise.all([...kept, ...dropped].map((path) => writeText(join(host, path), "export {};\n")));

    const { renderDir, notices } = await renderAgentDir({
      stateDir,
      repoHash: "r1",
      hostAgentDir: host,
      derived: derived(),
    });
    const tree = await listTree(renderDir);

    expect(kept.filter((path) => !tree.includes(path))).toEqual([]);
    expect(dropped.filter((path) => tree.includes(path))).toEqual([]);
    expect(notices).toEqual([
      "render: skills/deploy/.credentials looks like a secrets directory and stays out of the sandbox",
      "render: extensions/x/secrets looks like a secrets directory and stays out of the sandbox",
    ]);
  });

  it("removes leftover temporary files of earlier writers", async () => {
    const host = await tempDir("render-host");
    const stateDir = await tempDir("render-state");
    const { renderDir } = await renderAgentDir({
      stateDir,
      repoHash: "r1",
      hostAgentDir: host,
      derived: derived(),
    });
    const leftover = join(renderDir, `auth.json.${process.pid}.abcd1234.tmp`);

    await writeText(leftover, "partial");

    await renderAgentDir({ stateDir, repoHash: "r1", hostAgentDir: host, derived: derived() });

    expect(await listTree(renderDir)).not.toContain(basename(leftover));
  });

  it("renders the same repository from parallel launches without failing", async () => {
    const host = await hostAgentDir();
    const stateDir = await tempDir("render-state");
    const renders = Array.from({ length: 6 }, (_, index) =>
      renderAgentDir({
        stateDir,
        repoHash: "r1",
        hostAgentDir: host,
        derived: derived(`pi-sandbox-${String(index).repeat(24)}`),
      }),
    );

    await expect(Promise.all(renders)).resolves.toHaveLength(6);
  });
});

describe("the legacy render dir", () => {
  it("stays while another launch of the repository is live, and goes at a launch with none", async () => {
    const stateDir = await tempDir("render-legacy");
    const host = await hostAgentDir();
    const legacy = stateLayout(stateDir).repo("repo1").legacyRender;
    const input = { stateDir, repoHash: "repo1", hostAgentDir: host, derived: derived() };

    await writeText(join(legacy, "AGENTS.md"), "old");

    await renderAgentDir({ ...input, othersLive: async () => true });

    expect(await readFile(join(legacy, "AGENTS.md"), "utf8")).toBe("old");

    await renderAgentDir({ ...input, othersLive: async () => false });

    expect(await stat(legacy).catch(() => undefined)).toBeUndefined();
  });
});
