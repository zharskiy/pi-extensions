import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitSettingsFile } from "../../../cli/pinata/git-block.ts";
import { launcherRoot, stateLayout } from "../../../shared/index.ts";
import { exists } from "../../support/temp-dir.ts";
import { createPinata } from "./support.ts";

const blockOf = (packageDir: string) =>
  `# pinata begin\n[includeIf "gitdir:/"]\n\tpath = "${gitSettingsFile(packageDir)}"\n# pinata end\n`;

const uninstall = async (pinata: Awaited<ReturnType<typeof createPinata>>) => {
  await mkdir(pinata.harness.stateDir, { recursive: true });

  await writeFile(stateLayout(pinata.harness.stateDir).salt, "salt");

  return pinata.run("uninstall");
};

const gitRead = (cwd: string, global: string, key: string) =>
  execFileSync("git", ["config", "--get", key], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

const gitReadIn = (repo: string, home: string, key: string) =>
  execFileSync("git", ["config", "--get", key], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();

const shippedSettings = async (pinata: Awaited<ReturnType<typeof createPinata>>) => {
  const repo = join(pinata.harness.root, "plain-repo");

  await mkdir(join(pinata.packageDir, "launcher", "cli", "pinata"), { recursive: true });

  await writeFile(
    gitSettingsFile(pinata.packageDir),
    await readFile(gitSettingsFile(dirname(launcherRoot())), "utf8"),
  );

  await mkdir(repo);

  execFileSync("git", ["init", "-q", repo], {
    env: { PATH: process.env.PATH, HOME: repo, GIT_CONFIG_NOSYSTEM: "1" },
  });

  return repo;
};

describe("pinata's git settings", () => {
  it("ships the static file with the two core keys", async () => {
    expect(gitSettingsFile(dirname(launcherRoot()))).toBe(join(launcherRoot(), "cli", "pinata", "gitconfig"));
    expect(await readFile(gitSettingsFile(dirname(launcherRoot())), "utf8")).toBe(
      "[core]\n\tcheckStat = minimal\n\ttrustctime = false\n",
    );
  });

  it.each([
    ["the XDG file when both exist", ".config/git/config", [".gitconfig", ".config/git/config"], {}],
    ["~/.gitconfig when only it exists", ".gitconfig", [".gitconfig"], {}],
    ["the XDG file when only it exists", ".config/git/config", [".config/git/config"], {}],
    ["XDG_CONFIG_HOME's file", "xdg/git/config", ["xdg/git/config"], { XDG_CONFIG_HOME: "xdg" }],
    [
      "an empty XDG_CONFIG_HOME as ~/.config",
      ".config/git/config",
      [".config/git/config"],
      { XDG_CONFIG_HOME: "" },
    ],
    [
      "GIT_CONFIG_GLOBAL over both",
      "own",
      [".gitconfig", ".config/git/config"],
      { GIT_CONFIG_GLOBAL: "own" },
    ],
    ["a new ~/.gitconfig when neither exists", ".gitconfig", [], {}],
    ["~/.gitconfig when GIT_CONFIG_GLOBAL is empty", ".gitconfig", [], { GIT_CONFIG_GLOBAL: "" }],
  ])("writes the block into %s, and uninstall takes it out", async (_, target, present, env) => {
    const pinata = await createPinata();
    const at = (path: string) => join(pinata.home, path);

    await Promise.all(
      present.map(async (path) => {
        await mkdir(dirname(at(path)), { recursive: true });

        await writeFile(at(path), "");
      }),
    );

    Object.entries(env).forEach(([name, value]) => {
      pinata.harness.deps.env[name] = value === "" ? "" : at(value);
    });

    const others = present.filter((path) => path !== target);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(at(target), "utf8")).toBe(blockOf(pinata.packageDir));
    expect(pinata.harness.stdout()).toContain(`ok Added pinata's git settings to ~/${target}\n`);
    expect(await Promise.all(others.map((path) => readFile(at(path), "utf8")))).toEqual(others.map(() => ""));
    expect(await uninstall(pinata)).toBe(0);
    expect(await readFile(at(target), "utf8")).toBe("");
    expect(pinata.harness.stdout()).toContain(`ok Removed pinata's git settings from ~/${target}\n`);
  });

  it.each([
    ["GIT_CONFIG_GLOBAL is not a regular file", "/dev/null", ".gitconfig"],
    ["~/.gitconfig is a folder", undefined, ".gitconfig"],
  ])("leaves git alone when %s", async (_, global, folder) => {
    const pinata = await createPinata();

    if (global === undefined) {
      await mkdir(join(pinata.home, folder), { recursive: true });
    } else {
      pinata.harness.deps.env.GIT_CONFIG_GLOBAL = global;
    }

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(pinata.harness.stdout()).toContain(
      `! Left git's global settings alone: ${global ?? "~/.gitconfig"} is not a regular file\n`,
    );
    expect(await exists(join(pinata.home, ".config", "git", "config"))).toBe(false);
    expect(await uninstall(pinata)).toBe(0);
  });

  it.each([
    ["an empty file", ""],
    ["a comment-led file", "# mine\n[user]\n\tname = me\n"],
    ["a file without a final newline", "[core]\n\teditor = vim"],
    ["a file with a non-latin1 byte", "[user]\n\tname = Caf\xe9\n"],
  ])("puts the block at the start of %s and uninstall restores it byte for byte", async (_, text) => {
    const pinata = await createPinata();
    const file = join(pinata.home, ".gitconfig");

    await writeFile(file, text, "latin1");

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(file, "latin1")).toBe(`${blockOf(pinata.packageDir)}${text}`);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(file, "latin1")).toBe(`${blockOf(pinata.packageDir)}${text}`);
    expect(await uninstall(pinata)).toBe(0);
    expect(await readFile(file, "latin1")).toBe(text);
  });

  it("rewrites a block that has moved in place and leaves a broken marker pair alone", async () => {
    const pinata = await createPinata();
    const file = join(pinata.home, ".gitconfig");
    const broken = "[user]\n\tname = me\n# pinata end\n";

    await writeFile(file, "[user]\n\tname = me\n# pinata begin\nold\n# pinata end\n");

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(file, "utf8")).toBe(`[user]\n\tname = me\n${blockOf(pinata.packageDir)}`);

    await writeFile(file, broken);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(file, "utf8")).toBe(broken);
    expect(pinata.harness.stdout()).toContain(
      '! Left ~/.gitconfig as it is: it has a "# pinata begin" or "# pinata end" line without its pair\n',
    );
  });

  it("gives git pinata's values in every repository, and the user's own value wins", async () => {
    const pinata = await createPinata({ global: true });
    const file = join(pinata.home, ".gitconfig");
    const repo = await shippedSettings(pinata);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect([gitRead(repo, file, "core.checkStat"), gitRead(repo, file, "core.trustctime")]).toEqual([
      "minimal",
      "false",
    ]);

    execFileSync("git", ["config", "--global", "core.trustctime", "true"], {
      env: { PATH: process.env.PATH, HOME: repo, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: "1" },
    });

    expect(gitRead(repo, file, "core.trustctime")).toBe("true");
    expect((await readFile(file, "utf8")).startsWith(blockOf(pinata.packageDir))).toBe(true);
  });

  it("lets a value in the XDG file win when ~/.gitconfig exists too, and moves an older block there", async () => {
    const pinata = await createPinata({ global: true });
    const repo = await shippedSettings(pinata);
    const xdg = join(pinata.home, ".config", "git", "config");
    const home = join(pinata.home, ".gitconfig");
    const own = "[core]\n\ttrustctime = true\n";

    await mkdir(dirname(xdg), { recursive: true });

    await writeFile(xdg, own);

    await writeFile(home, `${blockOf(pinata.packageDir)}[user]\n\tname = me\n`);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(xdg, "utf8")).toBe(`${blockOf(pinata.packageDir)}${own}`);
    expect(await readFile(home, "utf8")).toBe("[user]\n\tname = me\n");
    expect([
      gitReadIn(repo, pinata.home, "core.checkStat"),
      gitReadIn(repo, pinata.home, "core.trustctime"),
    ]).toEqual(["minimal", "true"]);

    await writeFile(home, `${blockOf(pinata.packageDir)}[user]\n\tname = me\n`);

    expect(await uninstall(pinata)).toBe(0);
    expect(await Promise.all([xdg, home].map((file) => readFile(file, "utf8")))).toEqual([
      own,
      "[user]\n\tname = me\n",
    ]);
  });

  it("keeps a byte-order mark first, and git still reads the file", async () => {
    const pinata = await createPinata({ global: true });
    const repo = await shippedSettings(pinata);
    const file = join(pinata.home, ".gitconfig");
    const text = "\uFEFF[user]\n\tname = me\n";

    await writeFile(file, text);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(file, "utf8")).toBe(`\uFEFF${blockOf(pinata.packageDir)}[user]\n\tname = me\n`);
    expect([gitRead(repo, file, "core.checkStat"), gitRead(repo, file, "user.name")]).toEqual([
      "minimal",
      "me",
    ]);
    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(file, "utf8")).toBe(`\uFEFF${blockOf(pinata.packageDir)}[user]\n\tname = me\n`);
    expect(await uninstall(pinata)).toBe(0);
    expect(await readFile(file, "utf8")).toBe(text);
  });

  it("knows its marker lines in a file with CRLF line ends", async () => {
    const pinata = await createPinata();
    const file = join(pinata.home, ".gitconfig");
    const own = "[user]\r\n\tname = me\r\n";

    await writeFile(file, `# pinata begin\r\nold\r\n# pinata end\r\n${own}`);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await readFile(file, "utf8")).toBe(`${blockOf(pinata.packageDir)}${own}`);

    await writeFile(file, `# pinata begin\r\nold\r\n# pinata end\r\n${own}`);

    expect(await uninstall(pinata)).toBe(0);
    expect(await readFile(file, "utf8")).toBe(own);
  });

  it("leaves an empty file when the block was all it held", async () => {
    const pinata = await createPinata();
    const file = join(pinata.home, ".gitconfig");

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await uninstall(pinata)).toBe(0);
    expect(await readFile(file, "utf8")).toBe("");
  });

  it("edits a linked config through the link and keeps its mode", async () => {
    const pinata = await createPinata();
    const file = join(pinata.home, ".gitconfig");
    const real = join(pinata.harness.root, "dotfiles", "gitconfig");

    await mkdir(dirname(real), { recursive: true });

    await writeFile(real, "[user]\n\tname = me\n", { mode: 0o600 });

    await symlink(real, file);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe(`${blockOf(pinata.packageDir)}[user]\n\tname = me\n`);
    expect((await stat(real)).mode & 0o777).toBe(0o600);
    expect(pinata.harness.stdout()).toContain("ok Added pinata's git settings to ~/.gitconfig\n");
    expect(await uninstall(pinata)).toBe(0);
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe("[user]\n\tname = me\n");
  });

  it("leaves a link to a missing file alone with a line saying so", async () => {
    const pinata = await createPinata();
    const file = join(pinata.home, ".gitconfig");
    const real = join(pinata.harness.root, "dotfiles", "gitconfig");

    await symlink(real, file);

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(await exists(real)).toBe(false);
    expect(pinata.harness.stdout()).toContain(
      "! Left ~/.gitconfig alone: it is a link to a file that does not exist\n",
    );
  });

  it("warns and goes on when GIT_CONFIG_GLOBAL names a file in a missing folder", async () => {
    const pinata = await createPinata();
    const file = join(pinata.harness.root, "missing", "gitconfig");

    pinata.harness.deps.env.GIT_CONFIG_GLOBAL = file;

    expect(await pinata.run("install", "--yes")).toBe(0);
    expect(pinata.harness.stdout()).toContain(`! Left ${file} as it is: writing it failed (ENOENT`);
    expect(pinata.harness.stdout()).toContain("Pinata is installed.");
    expect(await exists(dirname(file))).toBe(false);
  });

  it("warns and goes on when the config lives in a folder it cannot write, on install and uninstall", async () => {
    const pinata = await createPinata();
    const file = join(pinata.home, ".gitconfig");
    const store = join(pinata.harness.root, "store");
    const real = join(store, "gitconfig");

    await mkdir(store);

    await writeFile(real, "[user]\n\tname = me\n");

    await symlink(real, file);

    await chmod(store, 0o555);

    try {
      expect(await pinata.run("install", "--yes")).toBe(0);
      expect(pinata.harness.stdout()).toContain("! Left ~/.gitconfig as it is: writing it failed (EACCES");
      expect(pinata.harness.stdout()).toContain("Pinata is installed.");
      expect(await readFile(real, "utf8")).toBe("[user]\n\tname = me\n");

      await chmod(store, 0o755);

      await writeFile(real, `${blockOf(pinata.packageDir)}[user]\n\tname = me\n`);

      await chmod(store, 0o555);

      expect(await uninstall(pinata)).toBe(0);
      expect(pinata.harness.stdout()).toContain("! Left ~/.gitconfig as it is: writing it failed (EACCES");
      expect(pinata.harness.stdout()).toContain("Pinata is uninstalled.");
    } finally {
      await chmod(store, 0o755);
    }
  });
});
