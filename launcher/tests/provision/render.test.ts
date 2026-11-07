import { chmod, lstat, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DerivedSandboxPi } from "../../hostpi/index.ts";
import { renderAgentDir } from "../../provision/index.ts";
import { stateLayout } from "../../shared/index.ts";
import { tempDir, writeText } from "./fixtures.ts";

const derived = (key = "pi-sandbox-aaaaaaaaaaaaaaaaaaaaaaaa"): DerivedSandboxPi => ({
  rules: [],
  hosts: [],
  files: {
    "auth.json": { corp: { type: "api_key", key } },
    "models.json": { providers: {} },
    "mcp.json": { mcpServers: {} },
  },
  notices: [],
  vault: [],
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

    expect(result.renderDir).toBe(stateLayout(stateDir).render("repo1"));
    expect(await listTree(result.renderDir)).toEqual([
      "AGENTS.md",
      "agents/",
      "agents/reviewer.md",
      "auth.json",
      "extensions/",
      "extensions/tool/",
      "extensions/tool/tokenizer.js",
      "keybindings.json",
      "models.json",
      "skills/",
      "skills/deploy/",
      "skills/deploy/SKILL.md",
      "skills/deploy/run.sh",
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

    expect(await listTree(result.renderDir)).toEqual(["auth.json", "models.json"]);
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
  });
});
