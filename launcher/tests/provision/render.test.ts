import { chmod, lstat, readdir, readFile, rm, symlink } from "node:fs/promises";
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
    expect(result.entries).toEqual([
      "auth.json",
      "models.json",
      "agents",
      "skills",
      "extensions",
      "AGENTS.md",
      "keybindings.json",
    ]);
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

  it("gives the same bytes and hash for the same input and a new hash when content changes", async () => {
    const stateDir = await tempDir("render-state");
    const host = await hostAgentDir();
    const first = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });
    const bytes = await readFile(join(first.renderDir, "auth.json"));
    const second = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });

    expect(second.hash).toBe(first.hash);
    expect(await readFile(join(second.renderDir, "auth.json"))).toEqual(bytes);

    await writeText(join(host, "AGENTS.md"), "changed\n");

    const third = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived(),
    });
    const fourth = await renderAgentDir({
      stateDir,
      repoHash: "repo1",
      hostAgentDir: host,
      derived: derived("pi-sandbox-bbbbbbbbbbbbbbbbbbbbbbbb"),
    });

    expect(third.hash).not.toBe(first.hash);
    expect(fourth.hash).not.toBe(third.hash);
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

    expect(result.entries).not.toContain("skills");
    expect(result.entries).not.toContain("agents");
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

    expect(result.entries).toEqual(["auth.json", "models.json"]);
  });
});
