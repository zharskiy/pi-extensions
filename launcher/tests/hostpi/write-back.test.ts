import { chmod, lstat, readFile, readlink, rename, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeBackPackageChange } from "../../hostpi/index.ts";
import { tempDir, writeText } from "./fixtures.ts";

const settingsText = (value: unknown, indent: string) => `${JSON.stringify(value, null, indent)}\n`;

const setup = async (value: unknown, indent = "    ") => {
  const hostAgentDir = await tempDir("write-back");

  await writeText(join(hostAgentDir, "settings.json"), settingsText(value, indent));

  return { hostAgentDir, read: () => readFile(join(hostAgentDir, "settings.json"), "utf8") };
};

describe("writeBackPackageChange", () => {
  it("writes through a symlinked settings.json and keeps the link", async () => {
    const host = await setup({ packages: ["npm:first"] });
    const settings = join(host.hostAgentDir, "settings.json");
    const dotfile = join(host.hostAgentDir, "dotfiles-settings.json");

    await rename(settings, dotfile);

    await symlink(dotfile, settings);

    await writeBackPackageChange({ hostAgentDir: host.hostAgentDir, source: "npm:second", kind: "install" });

    expect((await lstat(settings)).isSymbolicLink()).toBe(true);
    expect(await readlink(settings)).toBe(dotfile);
    expect(JSON.parse(await readFile(dotfile, "utf8"))).toEqual({ packages: ["npm:first", "npm:second"] });
  });

  it("appends an installed package and keeps the other keys and the indentation", async () => {
    const original = { theme: "dark", packages: ["npm:first"], defaultModel: "m" };
    const host = await setup(original, "\t");
    const result = await writeBackPackageChange({
      hostAgentDir: host.hostAgentDir,
      source: "npm:second",
      kind: "install",
    });

    expect(result).toEqual({ changed: true });
    expect(await host.read()).toBe(
      settingsText({ ...original, packages: ["npm:first", "npm:second"] }, "\t"),
    );
  });

  it("replaces the entry for the same npm package in place with the given source, whatever its version", async () => {
    const host = await setup({ packages: ["npm:a", "npm:@scope/tool@1.0.0", "npm:b"] });

    await writeBackPackageChange({
      hostAgentDir: host.hostAgentDir,
      source: "npm:@scope/tool@2.0.0",
      kind: "install",
    });

    expect(JSON.parse(await host.read()).packages).toEqual(["npm:a", "npm:@scope/tool@2.0.0", "npm:b"]);
  });

  it("updates only the source of a host object entry and keeps its other fields", async () => {
    const host = await setup({
      packages: [{ source: "npm:tool@1.0.0", skills: ["review"], autoload: false }],
    });

    await writeBackPackageChange({
      hostAgentDir: host.hostAgentDir,
      source: "npm:tool@2.0.0",
      kind: "install",
    });

    expect(JSON.parse(await host.read()).packages).toEqual([
      { source: "npm:tool@2.0.0", skills: ["review"], autoload: false },
    ]);
  });

  it("removes a package and reports no change when it is absent", async () => {
    const host = await setup({ packages: ["npm:a", { source: "git:github.com/x/y" }] });
    const removed = await writeBackPackageChange({
      hostAgentDir: host.hostAgentDir,
      source: "git:github.com/x/y",
      kind: "remove",
    });
    const again = await writeBackPackageChange({
      hostAgentDir: host.hostAgentDir,
      source: "git:github.com/x/y",
      kind: "remove",
    });

    expect(removed).toEqual({ changed: true });
    expect(again).toEqual({ changed: false });
    expect(JSON.parse(await host.read()).packages).toEqual(["npm:a"]);
  });

  it("reports no change when the same entry is already installed", async () => {
    const host = await setup({ packages: ["npm:a"] });
    const before = await host.read();
    const result = await writeBackPackageChange({
      hostAgentDir: host.hostAgentDir,
      source: "npm:a",
      kind: "install",
    });

    expect(result).toEqual({ changed: false });
    expect(await host.read()).toBe(before);
  });

  it("creates the settings file when it is missing", async () => {
    const hostAgentDir = await tempDir("write-back");

    await writeBackPackageChange({ hostAgentDir, source: "npm:a", kind: "install" });

    expect(JSON.parse(await readFile(join(hostAgentDir, "settings.json"), "utf8"))).toEqual({
      packages: ["npm:a"],
    });
  });

  it("refuses to rewrite invalid JSON and keeps the file mode", async () => {
    const broken = await tempDir("write-back");

    await writeText(join(broken, "settings.json"), "{ nope");

    await expect(
      writeBackPackageChange({ hostAgentDir: broken, source: "npm:a", kind: "install" }),
    ).rejects.toThrow(/invalid JSON/);

    const host = await setup({ packages: [] });

    await chmod(join(host.hostAgentDir, "settings.json"), 0o600);

    await writeBackPackageChange({ hostAgentDir: host.hostAgentDir, source: "npm:a", kind: "install" });

    expect((await stat(join(host.hostAgentDir, "settings.json"))).mode & 0o777).toBe(0o600);
  });
});
