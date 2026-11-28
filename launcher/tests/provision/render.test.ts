import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DerivedSandboxPi, DerivedTools } from "../../hostpi/index.ts";
import { renderAgentDir } from "../../provision/index.ts";
import type { HostLinkGuard } from "../../provision/types.ts";
import { stateLayout } from "../../shared/index.ts";
import { NO_STATUS, OPEN_GUARD, tempDir, writeText } from "./fixtures.ts";

const NO_TOOLS: DerivedTools = {
  glab: [],
  maven: { servers: [], mirrors: [], passthrough: [] },
  git: {},
  env: {},
};

const derived = (
  key = "pinata-aaaaaaaaaaaaaaaaaaaaaaaa",
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

  return dir;
};

describe("renderAgentDir", () => {
  it("writes the rendered pi files and a filtered copy of the host entries", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();
    const result = await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });

    expect(result.renderDir).toBe(stateLayout(stateDir).render);
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
      "tools/gitconfig",
      "tools/m2-settings.xml",
      "tools/status.json",
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
      renderAgentDir({
        stateDir,
        hostAgentDir: host,
        hostHome: host,
        derived: derived(key),
        status: NO_STATUS,
        guard: OPEN_GUARD,
      });
    const first = await render();
    const auth = join(first.renderDir, "auth.json");
    const agents = join(first.renderDir, "AGENTS.md");
    const before = await stat(auth);

    await render();

    expect((await stat(auth)).ino).toBe(before.ino);

    await writeText(join(host, "AGENTS.md"), "changed\n");

    await render("pinata-bbbbbbbbbbbbbbbbbbbbbbbb");

    expect(await readFile(agents, "utf8")).toBe("changed\n");
    expect(JSON.parse(await readFile(auth, "utf8"))).toEqual(
      derived("pinata-bbbbbbbbbbbbbbbbbbbbbbbb").files["auth.json"],
    );
    expect((await stat(auth)).ino).not.toBe(before.ino);
  });

  it("rewrites a file of the same size whose bytes differ", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();
    const result = await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });

    await writeText(join(result.renderDir, "AGENTS.md"), "RULES\n");

    await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });

    expect(await readFile(join(result.renderDir, "AGENTS.md"), "utf8")).toBe("rules\n");
  });

  it("removes entries that are gone on the host", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();

    await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });

    await rm(join(host, "skills"), { recursive: true });

    await rm(join(host, "agents", "reviewer.md"));

    const result = await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });
    const tree = await listTree(result.renderDir);

    expect(tree.filter((path) => path.startsWith("skills") || path.startsWith("agents"))).toEqual([]);
  });

  it("works with an empty host agent dir", async () => {
    const stateDir = await tempDir("render-state");
    const host = await tempDir("render-host");
    const result = await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });

    expect(await listTree(result.renderDir)).toEqual([
      "auth.json",
      "mcp.json",
      "models.json",
      "tools/",
      "tools/gitconfig",
      "tools/m2-settings.xml",
      "tools/status.json",
    ]);
    expect(await readFile(join(result.renderDir, "tools", "gitconfig"), "utf8")).toBe(
      "[core]\n\tcheckStat = minimal\n\ttrustctime = false\n",
    );
  });

  it("renders Maven settings with the sandbox proxy and no credentials when the host has no settings.xml", async () => {
    const stateDir = await tempDir("render-state");
    const host = await tempDir("render-host");
    const result = await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });
    const settings = await readFile(join(result.renderDir, "tools", "m2-settings.xml"), "utf8");
    const proxy = /<proxy>([\s\S]*)<\/proxy>/.exec(settings)?.[1] ?? "";

    expect(proxy).toContain("<active>true</active>");
    expect(proxy).toContain("<host>pinata-proxy</host>");
    expect(proxy).toContain("<port>3128</port>");
    expect(proxy).toContain("<nonProxyHosts>localhost|127.*|[::1]|pinata-proxy</nonProxyHosts>");
    expect(proxy).not.toContain("<username>");
    expect(proxy).not.toContain("<password>");
  });

  it("renders the tool files of the derived glab, npm, pip, Maven and git settings", async () => {
    const stateDir = await tempDir("render-state");
    const host = await tempDir("render-host");
    const P = "pinata-bbbbbbbbbbbbbbbbbbbbbbbb";
    const result = await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(undefined, {
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
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });
    const read = (name: string) => readFile(join(result.renderDir, "tools", name), "utf8");

    expect((await readdir(join(result.renderDir, "tools"))).sort()).toEqual([
      "gitconfig",
      "glab-config.yml",
      "m2-settings.xml",
      "npmrc",
      "pip.conf",
      "status.json",
    ]);
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
        "[core]",
        "\tcheckStat = minimal",
        "\ttrustctime = false",
        "[user]",
        '\tname = "Max \\"Z\\""',
        '\temail = "max@corp.test"',
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
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
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
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
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
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });
    const leftover = join(renderDir, `auth.json.${process.pid}.abcd1234.tmp`);

    await writeText(leftover, "partial");

    await renderAgentDir({
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });

    expect(await listTree(renderDir)).not.toContain(basename(leftover));
  });

  it("renders the same repository from parallel launches without failing", async () => {
    const host = await hostAgentDir();
    const stateDir = await tempDir("render-state");
    const renders = Array.from({ length: 6 }, (_, index) =>
      renderAgentDir({
        stateDir,
        hostAgentDir: host,
        hostHome: host,
        derived: derived(`pinata-${String(index).repeat(24)}`),
        status: NO_STATUS,
        guard: OPEN_GUARD,
      }),
    );

    await expect(Promise.all(renders)).resolves.toHaveLength(6);
  });

  it("renders one project after another into the shared render dir with nothing left from the first", async () => {
    const stateDir = await tempDir("render-state");
    const first = await hostAgentDir();
    const second = await tempDir("render-host");

    await writeText(join(second, "skills", "lint", "SKILL.md"), "lint\n");

    const inputOf = (host: string, key: string, setup: string[][]) => ({
      hostAgentDir: host,
      hostHome: host,
      derived: derived(key),
      status: { ...NO_STATUS, setup },
      guard: OPEN_GUARD,
    });
    const projectA = inputOf(first, `pinata-${"a".repeat(24)}`, [["npm", "ci"]]);
    const projectB = inputOf(second, `pinata-${"b".repeat(24)}`, []);
    const snapshot = async (dir: string) =>
      Promise.all(
        (await listTree(dir)).map(async (path) =>
          path.endsWith("/") ? [path] : [path, await readFile(join(dir, path), "utf8")],
        ),
      );
    const fresh = async (input: typeof projectA) =>
      snapshot((await renderAgentDir({ ...input, stateDir: await tempDir("render-state") })).renderDir);

    const { renderDir } = await renderAgentDir({ ...projectA, stateDir });

    await renderAgentDir({ ...projectB, stateDir });

    expect(await snapshot(renderDir)).toEqual(await fresh(projectB));

    await renderAgentDir({ ...projectA, stateDir });

    expect(await snapshot(renderDir)).toEqual(await fresh(projectA));
  });
});

describe("the user skills of ~/.agents/skills", () => {
  const render = async (host: string, hostHome: string) =>
    renderAgentDir({
      stateDir: await tempDir("render-state"),
      hostAgentDir: host,
      hostHome,
      derived: derived(),
      status: NO_STATUS,
      guard: OPEN_GUARD,
    });

  it("renders them into their own render subdir with the agent dir filters", async () => {
    const host = await tempDir("render-host");
    const home = await tempDir("render-home");
    const skills = join(home, ".agents", "skills");

    await writeText(join(skills, "deploy", "SKILL.md"), "deploy\n");

    await writeText(join(skills, "deploy", ".env"), "TOKEN=SECRET\n");

    await writeText(join(skills, "deploy", "secrets", "prod.json"), "{}\n");

    await writeText(join(skills, "deploy", "huge.bin"), Buffer.alloc(8 * 1024 * 1024 + 1));

    const { renderDir, notices } = await render(host, home);
    const tree = await listTree(renderDir);

    expect(tree.filter((path) => path.startsWith("agents-skills"))).toEqual([
      "agents-skills/",
      "agents-skills/deploy/",
      "agents-skills/deploy/SKILL.md",
    ]);
    expect(notices).toEqual([
      "render: ~/.agents/skills/deploy/secrets looks like a secrets directory and stays out of the sandbox",
      "render: left out of the sandbox: ~/.agents/skills/deploy/.env (secret-looking name), ~/.agents/skills/deploy/huge.bin (over 8 MiB)",
    ]);
  });

  it("renders nothing for them when the host has no ~/.agents/skills", async () => {
    const { renderDir, notices } = await render(await tempDir("render-host"), await tempDir("render-home"));

    expect((await listTree(renderDir)).filter((path) => path.startsWith("agents-skills"))).toEqual([]);
    expect(notices).toEqual([]);
  });
});

describe("symlinks in the rendered host entries", () => {
  const render = async (host: string, hostHome: string, guard: HostLinkGuard = OPEN_GUARD) =>
    renderAgentDir({
      stateDir: await tempDir("render-state"),
      hostAgentDir: host,
      hostHome,
      derived: derived(),
      status: NO_STATUS,
      guard,
    });

  const refusing = (root: string): HostLinkGuard => {
    const reason = (real: string) => (real.startsWith(root) ? `it lies in ${root}` : undefined);

    return { writable: reason, link: reason };
  };

  const realTemp = async (prefix: string) => realpath(await tempDir(prefix));

  const copiedFiles = (tree: string[]) =>
    tree.filter((path) => /^(agents-)?(skills|agents|prompts)\/.*[^/]$/.test(path));

  it("are followed and copied as plain files and folders", async () => {
    const host = await realTemp("render-host");
    const home = await realTemp("render-home");

    await writeText(join(home, "elsewhere", "review", "SKILL.md"), "review\n");

    await writeText(join(home, "notes", "linked.md"), "linked\n");

    await mkdir(join(host, "skills"));

    await mkdir(join(host, "agents"));

    await symlink(join(home, "elsewhere", "review"), join(host, "skills", "review"));

    await symlink(join(home, "notes", "linked.md"), join(host, "agents", "linked.md"));

    await symlink(join(home, "notes"), join(host, "prompts"));

    const { renderDir, notices } = await render(host, home);
    const tree = await listTree(renderDir);
    const links = await Promise.all(
      tree.map(async (path) => (await lstat(join(renderDir, path))).isSymbolicLink()),
    );

    expect(copiedFiles(tree)).toEqual(["agents/linked.md", "prompts/linked.md", "skills/review/SKILL.md"]);
    expect(await readFile(join(renderDir, "skills", "review", "SKILL.md"), "utf8")).toBe("review\n");
    expect(links.some(Boolean)).toBe(false);
    expect(notices).toEqual([]);
  });

  it("stay unreported for a skill linked into ~/.agents/skills, which the sandbox carries on its own", async () => {
    const host = await tempDir("render-host");
    const home = await tempDir("render-home");
    const skills = join(home, ".agents", "skills");

    await writeText(join(skills, "deploy", "SKILL.md"), "deploy\n");

    await writeText(join(host, "skills", "own", "SKILL.md"), "own\n");

    await symlink(join(skills, "deploy"), join(host, "skills", "deploy"));

    const { renderDir, notices } = await render(host, home);
    const tree = await listTree(renderDir);

    expect(tree.filter((path) => path.endsWith("SKILL.md"))).toEqual([
      "agents-skills/deploy/SKILL.md",
      "skills/own/SKILL.md",
    ]);
    expect(notices).toEqual([]);
  });

  it("follow ~/.agents/skills when it is itself a link and still carry a skill linked into it once", async () => {
    const host = await tempDir("render-host");
    const home = await tempDir("render-home");

    await writeText(join(home, "dotfiles", "skills", "deploy", "SKILL.md"), "deploy\n");

    await mkdir(join(host, "skills"), { recursive: true });

    await mkdir(join(home, ".agents"));

    await symlink(join(home, "dotfiles", "skills"), join(home, ".agents", "skills"));

    await symlink(join(home, ".agents", "skills", "deploy"), join(host, "skills", "deploy"));

    const { renderDir, notices } = await render(host, home);

    expect(copiedFiles(await listTree(renderDir))).toEqual(["agents-skills/deploy/SKILL.md"]);
    expect(notices).toEqual([]);
  });

  it("are followed at any depth", async () => {
    const host = await tempDir("render-host");
    const home = await tempDir("render-home");
    const skills = join(home, ".agents", "skills");

    await writeText(join(skills, "_shared", "ref.md"), "ref\n");

    await writeText(join(skills, "deploy", "SKILL.md"), "deploy\n");

    await symlink("../_shared", join(skills, "deploy", "shared"));

    const { renderDir, notices } = await render(host, home);

    expect(copiedFiles(await listTree(renderDir))).toEqual([
      "agents-skills/_shared/ref.md",
      "agents-skills/deploy/SKILL.md",
      "agents-skills/deploy/shared/ref.md",
    ]);
    expect(notices).toEqual([]);
  });

  it("are named with the reason and copied from nowhere when the guard refuses their target", async () => {
    const host = await realTemp("render-host");
    const home = await realTemp("render-home");
    const work = join(home, "work");

    await writeText(join(work, "x", "SKILL.md"), "planted\n");

    await writeText(join(host, "skills", "own", "SKILL.md"), "own\n");

    await symlink(join(work, "x"), join(host, "skills", "x"));

    const { renderDir, notices } = await render(host, home, refusing(work));

    expect(copiedFiles(await listTree(renderDir))).toEqual(["skills/own/SKILL.md"]);
    expect(notices).toEqual([
      `render: not carried into the sandbox: skills/x -> ${join(work, "x")} (it lies in ${work}); move each target out of the folder named, or put a real copy in place of the link`,
    ]);
  });

  it("copy nothing from a source whose real folder a sandbox can write, and name it", async () => {
    const host = await realTemp("render-host");
    const home = await realTemp("render-home");
    const work = join(home, "work");

    await writeText(join(work, ".agents", "skills", "deploy", "SKILL.md"), "deploy\n");

    await writeText(join(home, ".config", "gh", "hosts.yml"), "token: SECRET\n");

    await symlink(
      join(home, ".config", "gh", "hosts.yml"),
      join(work, ".agents", "skills", "deploy", "hosts.md"),
    );

    await symlink(join(work, ".agents"), join(home, ".agents"));

    const { renderDir, notices } = await render(host, home, refusing(work));

    expect(copiedFiles(await listTree(renderDir))).toEqual([]);
    expect(notices).toEqual([
      `render: not carried into the sandbox: ~/.agents/skills (it lies in ${work}); move each target out of the folder named, or put a real copy in place of the link`,
    ]);
  });

  it("stop at links that loop, silently", async () => {
    const host = await tempDir("render-host");
    const skill = join(host, "skills", "d");

    await writeText(join(skill, "SKILL.md"), "d\n");

    await writeText(join(skill, "a", "x.md"), "x\n");

    await writeText(join(skill, "b", "y.md"), "y\n");

    await symlink(skill, join(skill, "loop"));

    await symlink(join(skill, "b"), join(skill, "a", "l"));

    await symlink(join(skill, "a"), join(skill, "b", "l"));

    const { renderDir, notices } = await render(host, await tempDir("render-home"));

    expect(copiedFiles(await listTree(renderDir))).toEqual([
      "skills/d/SKILL.md",
      "skills/d/a/l/y.md",
      "skills/d/a/x.md",
      "skills/d/b/l/x.md",
      "skills/d/b/y.md",
    ]);
    expect(notices).toEqual([]);
  });

  it("stop at a link whose target holds the folder it lies in", async () => {
    const host = await tempDir("render-host");
    const outside = await tempDir("render-outside");

    await writeText(join(host, "skills", "s", "SKILL.md"), "s\n");

    await writeText(join(outside, "y", "other.md"), "other\n");

    await writeText(join(outside, "y", "z", "f.md"), "f\n");

    await symlink(join(outside, "y"), join(outside, "y", "z", "up"));

    await symlink(join(outside, "y", "z"), join(host, "skills", "s", "deep"));

    const { renderDir, notices } = await render(host, await tempDir("render-home"));

    expect(copiedFiles(await listTree(renderDir))).toEqual(["skills/s/SKILL.md", "skills/s/deep/f.md"]);
    expect(notices).toEqual([]);
  });

  it("render past a linked folder that cannot be read", async () => {
    const host = await tempDir("render-host");
    const locked = join(await tempDir("render-outside"), "locked");

    await writeText(join(host, "skills", "own", "SKILL.md"), "own\n");

    await mkdir(locked);

    await chmod(locked, 0o000);

    await symlink(locked, join(host, "skills", "locked"));

    const { renderDir, notices } = await render(host, await tempDir("render-home"));

    expect(copiedFiles(await listTree(renderDir))).toEqual(["skills/own/SKILL.md"]);
    expect(notices).toEqual([]);
  });

  it("skip a broken link silently", async () => {
    const host = await tempDir("render-host");

    await writeText(join(host, "skills", "own", "SKILL.md"), "own\n");

    await symlink(join(host, "missing"), join(host, "skills", "gone"));

    const { renderDir, notices } = await render(host, await tempDir("render-home"));

    expect(copiedFiles(await listTree(renderDir))).toEqual(["skills/own/SKILL.md"]);
    expect(notices).toEqual([]);
  });

  it("pass the name filters by both the link name and the target name", async () => {
    const host = await tempDir("render-host");
    const home = await tempDir("render-home");

    await writeText(join(host, "skills", "x", "SKILL.md"), "x\n");

    await writeText(join(home, "elsewhere", "notes.txt"), "notes\n");

    await writeText(join(home, "elsewhere", "id_rsa"), "key\n");

    await writeText(join(home, "elsewhere", "secrets", "prod.md"), "prod\n");

    await symlink(join(home, "elsewhere", "notes.txt"), join(host, "skills", "x", ".env"));

    await symlink(join(home, "elsewhere", "id_rsa"), join(host, "skills", "x", "notes"));

    await symlink(join(home, "elsewhere", "secrets"), join(host, "skills", "x", "docs"));

    const { renderDir, notices } = await render(host, home);

    expect(copiedFiles(await listTree(renderDir))).toEqual(["skills/x/SKILL.md"]);
    expect(notices).toEqual([
      "render: skills/x/docs looks like a secrets directory and stays out of the sandbox",
      "render: left out of the sandbox: skills/x/.env (secret-looking name), skills/x/notes (secret-looking name)",
    ]);
  });

  it("renders the status file from the config-derived input and keeps it through stale removal", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();
    const status = {
      resources: { cpus: 2, pids: 256, shmMiB: 64 },
      volumes: ["/home/pi/.m2", "/home/pi/.gradle"],
      binds: ["/data"],
      setup: [["npm", "ci"]],
      services: [],
    };
    const input = {
      stateDir,
      hostAgentDir: host,
      hostHome: host,
      derived: derived(),
      status,
      guard: OPEN_GUARD,
    };
    const first = await renderAgentDir(input);
    const path = join(first.renderDir, "tools", "status.json");
    const text = await readFile(path, "utf8");

    await renderAgentDir(input);

    expect(await readFile(path, "utf8")).toBe(text);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      proxy: {
        url: "http://pinata-proxy:3128",
        denials: "http://pinata-proxy:3128/denials",
        health: "http://pinata-proxy:3128/healthz",
      },
      resources: { cpus: 2, pids: 256, shmMiB: 64 },
      volumes: [{ target: "/home/pi/.m2" }, { target: "/home/pi/.gradle" }],
      binds: [{ target: "/data" }],
      setup: [["npm", "ci"]],
      services: [],
    });
    expect(text).not.toContain(host);
  });
});
