import { lstat, mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carryChangelogMarker } from "../../provision/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const KEY = "extensionChangelogVersions";

const keyOf = (source: string) => JSON.stringify({ source, scope: "user" });

const OLD = "npm:@zharskiy/pinata@0.5.0";

const NEW = "npm:@zharskiy/pinata@0.6.0";

const agentDir = async (settings?: unknown) => {
  const dir = join(await tempDir("marker"), "agent");

  await mkdir(dir, { recursive: true });

  if (settings !== undefined) {
    await writeFile(join(dir, "settings.json"), JSON.stringify(settings), { mode: 0o640 });
  }

  return dir;
};

const settingsOf = async (dir: string) => JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));

describe("carrying pi's changelog marker to a new package source", () => {
  it("moves the last seen version from the old source's key to the new one and keeps every other key", async () => {
    const dir = await agentDir({
      packages: [NEW],
      theme: "dark",
      [KEY]: { [keyOf(OLD)]: "0.5.0", [keyOf("npm:other@1")]: "1.0.0" },
    });

    expect(await carryChangelogMarker(dir, [OLD], NEW)).toBe(true);
    expect(await settingsOf(dir)).toEqual({
      packages: [NEW],
      theme: "dark",
      [KEY]: { [keyOf("npm:other@1")]: "1.0.0", [keyOf(NEW)]: "0.5.0" },
    });
    expect((await stat(join(dir, "settings.json"))).mode & 0o777).toBe(0o640);
    expect(await readFile(join(dir, "settings.json"), "utf8")).toMatch(/^\{\n {2}"packages"[\s\S]*\}\n$/);
  });

  it("lets the older version win over one pi already recorded for the new source", async () => {
    const dir = await agentDir({ [KEY]: { [keyOf(OLD)]: "0.5.0", [keyOf(NEW)]: "0.6.0" } });

    expect(await carryChangelogMarker(dir, [OLD], NEW)).toBe(true);
    expect((await settingsOf(dir))[KEY]).toEqual({ [keyOf(NEW)]: "0.5.0" });
  });

  it("changes nothing when the old source has no marker, the source is unchanged, or there is no settings.json", async () => {
    const markers = { [KEY]: { [keyOf(NEW)]: "0.6.0" } };
    const absent = await agentDir(markers);
    const same = await agentDir({ [KEY]: { [keyOf(NEW)]: "0.5.0" } });
    const none = await agentDir();

    expect(await carryChangelogMarker(absent, [OLD], NEW)).toBe(false);
    expect(await settingsOf(absent)).toEqual(markers);
    expect(await carryChangelogMarker(same, [NEW], NEW)).toBe(false);
    expect((await settingsOf(same))[KEY]).toEqual({ [keyOf(NEW)]: "0.5.0" });
    expect(await carryChangelogMarker(none, [OLD], NEW)).toBe(false);
  });

  it("takes pi's settings.json.lock while it writes and removes it afterwards", async () => {
    const dir = await agentDir({ [KEY]: { [keyOf(OLD)]: "0.5.0" } });
    const lock = join(dir, "settings.json.lock");

    await mkdir(lock);

    const carried = carryChangelogMarker(dir, [OLD], NEW);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await settingsOf(dir))[KEY]).toEqual({ [keyOf(OLD)]: "0.5.0" });

    await rmdir(lock);

    expect(await carried).toBe(true);
    expect((await settingsOf(dir))[KEY]).toEqual({ [keyOf(NEW)]: "0.5.0" });
    expect(
      await lstat(lock).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("goes ahead without the lock when pi holds it past the bound, and leaves pi's lock alone", async () => {
    const dir = await agentDir({ [KEY]: { [keyOf(OLD)]: "0.5.0" } });
    const lock = join(dir, "settings.json.lock");

    await mkdir(lock);

    expect(await carryChangelogMarker(dir, [OLD], NEW)).toBe(true);
    expect((await settingsOf(dir))[KEY]).toEqual({ [keyOf(NEW)]: "0.5.0" });
    expect((await lstat(lock)).isDirectory()).toBe(true);
  });
});
