import { chmod, lstat, mkdir, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffOf,
  isReindented,
  readDocument,
  serialise,
  withoutOwned,
  writeDocument,
} from "../../cli/setup/document.ts";
import { editedConfig } from "../../cli/setup/plan.ts";
import type { Answers } from "../../cli/setup/types.ts";
import { tempDir } from "../support/temp-dir.ts";
import { documentOf as fixtureDocument } from "./setup-fixtures.ts";

const FILE = "/config/config.json";

const documentOf = (text: string | undefined) => fixtureDocument(text, FILE);

const KEEP: Answers = { roots: ["~/work"], vm: "automatic", writeBack: true };

describe("reading the config document", () => {
  it("detects the indent and the trailing newline", () => {
    expect(documentOf('{\n  "egress": {}\n}\n')).toMatchObject({ indent: "  ", newline: true });
    expect(documentOf('{\n    "egress": {}\n}')).toMatchObject({ indent: "    ", newline: false });
    expect(documentOf('{\n\t"egress": {}\n}\n')).toMatchObject({ indent: "\t" });
    expect(documentOf("{}")).toMatchObject({ indent: "  ", newline: false, value: {} });
  });

  it("treats a missing file as an empty object that ends with a newline", () => {
    expect(documentOf(undefined)).toEqual({
      file: FILE,
      text: undefined,
      value: {},
      indent: "  ",
      newline: true,
    });
  });

  it("refuses text that is not a JSON object", () => {
    expect(readDocument(FILE, "{ broken")).toMatchObject({ ok: false, kind: "json" });
    expect(readDocument(FILE, "[1]")).toEqual({
      ok: false,
      kind: "json",
      message: "the file holds JSON, but not an object",
    });
  });

  it("refuses a file invalid outside the keys setup owns, and accepts one invalid only in them", () => {
    expect(readDocument(FILE, JSON.stringify({ egress: { allow: ["https://x.test"] } }))).toMatchObject({
      ok: false,
      kind: "config",
      message: expect.stringContaining("config: egress.allow[0]"),
    });
    expect(readDocument(FILE, JSON.stringify({ surprise: true }))).toMatchObject({
      ok: false,
      kind: "config",
    });
    expect(readDocument(FILE, JSON.stringify({ vm: { memoryGiB: "lots" }, workspaceRoots: 3 })).ok).toBe(
      true,
    );
    expect(readDocument(FILE, JSON.stringify({ vm: { cpus: 2, extra: 1 } }))).toMatchObject({ ok: false });
  });

  it("drops only the owned keys and the objects they leave empty", () => {
    expect(
      withoutOwned({
        workspaceRoots: { roots: [] },
        vm: { cpus: 2 },
        writeBack: { enabled: false, exclude: {} },
        egress: { allow: [] },
      }),
    ).toEqual({ writeBack: { exclude: {} }, egress: { allow: [] } });
  });
});

describe("editing the config document", () => {
  const STANDARD = `${JSON.stringify(
    {
      $schema: "../schema/sandbox-config.schema.json",
      credentials: { rules: [{ id: "r", host: "a.test", header: "authorization", secret: { env: "A" } }] },
      workspaceRoots: { roots: ["~/work", "/Volumes/Code/"] },
      egress: { allow: ["a.test"] },
      vm: { cpus: 4, memoryGiB: 8, diskGiB: 80 },
      image: { packages: ["jq"] },
      futureKey: { kept: [1, 2] },
    },
    null,
    2,
  )}\n`;

  it("keeps every other key, its order and its bytes when only an owned value changes", () => {
    const document = { file: FILE, text: STANDARD, value: JSON.parse(STANDARD), indent: "  ", newline: true };
    const next = editedConfig(document.value, {
      roots: ["~/work", "/Volumes/Code/"],
      vm: { cpus: 6, memoryGiB: 8, diskGiB: 80 },
      writeBack: true,
    });

    expect(serialise(document, next)).toBe(STANDARD.replace('"cpus": 4', '"cpus": 6'));
    expect(isReindented(document)).toBe(false);
  });

  it("appends new top-level keys in the order workspaceRoots, vm, writeBack, and new child keys inside", () => {
    const appended = editedConfig(
      { egress: { allow: [] } },
      { roots: ["~/work"], vm: { cpus: 2, memoryGiB: 4, diskGiB: 60 }, writeBack: false },
    );
    const inside = editedConfig(
      { writeBack: { exclude: {} }, vm: {} },
      { ...KEEP, vm: { cpus: 2, memoryGiB: 4, diskGiB: 60 }, writeBack: false },
    );

    expect(Object.keys(appended)).toEqual(["egress", "workspaceRoots", "vm", "writeBack"]);
    expect(inside).toEqual({
      writeBack: { exclude: {}, enabled: false },
      vm: { cpus: 2, memoryGiB: 4, diskGiB: 60 },
      workspaceRoots: { roots: ["~/work"] },
    });
  });

  it("removes the vm keys and an emptied vm for automatic, and writes all three for custom", () => {
    expect(editedConfig({ vm: { cpus: 4 }, image: {} }, KEEP)).toEqual({
      image: {},
      workspaceRoots: { roots: ["~/work"] },
    });
    expect(editedConfig({}, { ...KEEP, vm: { cpus: 8, memoryGiB: 10, diskGiB: 60 } }).vm).toEqual({
      cpus: 8,
      memoryGiB: 10,
      diskGiB: 60,
    });
    expect(editedConfig({ vm: { cpus: 4 } }, { ...KEEP, vm: { kept: { cpus: 4 } } }).vm).toEqual({ cpus: 4 });
  });

  it("leaves an unset writeBack.enabled unset when it stays on, and never removes a set one", () => {
    expect(editedConfig({}, KEEP)).toEqual({ workspaceRoots: { roots: ["~/work"] } });
    expect(editedConfig({ writeBack: { enabled: false } }, KEEP).writeBack).toEqual({ enabled: true });
    expect(editedConfig({ writeBack: { enabled: true } }, KEEP).writeBack).toEqual({ enabled: true });
  });

  it("removes workspaceRoots for home sharing and keeps the spelling of roots", () => {
    expect(
      editedConfig({ workspaceRoots: { roots: ["~/w"] }, egress: {} }, { ...KEEP, roots: "home" }),
    ).toEqual({
      egress: {},
    });
    expect(
      editedConfig(
        { workspaceRoots: { roots: ["/Users/me/w/"] } },
        { ...KEEP, roots: ["/Users/me/w/", "~/new"] },
      ),
    ).toEqual({ workspaceRoots: { roots: ["/Users/me/w/", "~/new"] } });
  });

  it("says when serialising changes the formatting", () => {
    expect(isReindented(documentOf('{ "egress": { "allow": ["a.test"] } }\n'))).toBe(true);
    expect(
      isReindented(documentOf('{\n  "egress": {\n    "allow": [\n      "a.test"\n    ]\n  }\n}\n')),
    ).toBe(false);
    expect(isReindented(documentOf(undefined))).toBe(false);
  });
});

describe("diffOf", () => {
  it("lists added, changed and removed leaves with dotted keys, arrays as whole values", () => {
    expect(
      diffOf(
        { workspaceRoots: { roots: ["~/a"] }, vm: { cpus: 4, diskGiB: 60 }, egress: { allow: ["x"] } },
        {
          workspaceRoots: { roots: ["~/a", "~/b"] },
          vm: { cpus: 6 },
          writeBack: { enabled: false },
          egress: { allow: ["x"] },
        },
      ),
    ).toEqual([
      { key: "workspaceRoots.roots", kind: "change", before: ["~/a"], after: ["~/a", "~/b"] },
      { key: "vm.cpus", kind: "change", before: 4, after: 6 },
      { key: "vm.diskGiB", kind: "remove", before: 60 },
      { key: "writeBack.enabled", kind: "add", after: false },
    ]);
  });

  it("finds nothing between equal objects", () => {
    expect(diffOf({ a: { b: [1] } }, { a: { b: [1] } })).toEqual([]);
  });
});

describe("writing the config document", () => {
  const fileIn = async () => {
    const dir = await tempDir("setup-write");

    return { dir, file: join(dir, "pi-sandbox", "config.json") };
  };

  it("creates a missing file with mode 0600 in a folder with mode 0700", async () => {
    const { dir, file } = await fileIn();

    await writeDocument({ file, text: undefined, value: {}, indent: "  ", newline: true }, "{}\n");

    expect(await readFile(file, "utf8")).toBe("{}\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "pi-sandbox"))).mode & 0o777).toBe(0o700);
  });

  it("refuses to write when the file changed since it was read, and keeps the other writer's text", async () => {
    const { file } = await fileIn();

    await mkdir(join(file, ".."), { recursive: true });

    await writeFile(file, "{}\n");

    const document = documentOf("{}\n");

    await writeFile(file, '{ "egress": {} }\n');

    await expect(writeDocument({ ...document, file }, '{ "vm": {} }\n')).rejects.toThrow(
      `could not save ${file}: the file changed while setup ran`,
    );
    expect(await readFile(file, "utf8")).toBe('{ "egress": {} }\n');
  });

  it("writes through a link to its target and keeps the target's mode", async () => {
    const { dir, file } = await fileIn();
    const target = join(dir, "dotfiles", "config.json");

    await mkdir(join(dir, "dotfiles"), { recursive: true });

    await mkdir(join(file, ".."), { recursive: true });

    await writeFile(target, "{}\n");

    await chmod(target, 0o640);

    await symlink(target, file);

    await writeDocument({ ...documentOf("{}\n"), file }, '{\n  "vm": {}\n}\n');

    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readlink(file)).toBe(target);
    expect(await readFile(target, "utf8")).toBe('{\n  "vm": {}\n}\n');
    expect((await stat(target)).mode & 0o777).toBe(0o640);
  });

  it("writes a new file through a dangling link when the target's folder exists", async () => {
    const { dir, file } = await fileIn();
    const target = join(dir, "dotfiles", "config.json");

    await mkdir(join(dir, "dotfiles"), { recursive: true });

    await mkdir(join(file, ".."), { recursive: true });

    await symlink("../dotfiles/config.json", file);

    await writeDocument({ ...documentOf(undefined), file }, "{}\n");

    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });

  it("refuses a dangling link whose target folder is missing, and keeps the link", async () => {
    const { dir, file } = await fileIn();

    await mkdir(join(file, ".."), { recursive: true });

    await symlink(join(dir, "gone", "config.json"), file);

    await expect(writeDocument({ ...documentOf(undefined), file }, "{}\n")).rejects.toThrow(
      `could not save ${file}: it is a link to ${join(dir, "gone", "config.json")}, whose folder does not exist`,
    );
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
  });

  it("names a folder that is not writable once, without the raw error", async () => {
    const { file } = await fileIn();

    await mkdir(join(file, ".."), { recursive: true });

    await chmod(join(file, ".."), 0o500);

    const failure = await writeDocument({ ...documentOf(undefined), file }, "{}\n").catch(
      (error: unknown) => error as Error,
    );

    await chmod(join(file, ".."), 0o700);

    expect(failure?.message).toBe(`could not save ${file}: its folder is not writable`);
  });
});

describe("the bytes of the file", () => {
  it("names a byte-order mark in words", () => {
    expect(readDocument(FILE, '\uFEFF{ "vm": {} }\n')).toEqual({
      ok: false,
      kind: "json",
      message: "the file starts with a byte-order mark (BOM); save it as UTF-8 without one",
    });
  });

  it("keeps CRLF line endings", () => {
    const text = '{\r\n  "egress": {}\r\n}\r\n';
    const document = documentOf(text);

    expect(isReindented(document)).toBe(false);
    expect(serialise(document, { ...document.value, vm: { cpus: 4 } })).toBe(
      '{\r\n  "egress": {},\r\n  "vm": {\r\n    "cpus": 4\r\n  }\r\n}\r\n',
    );
  });
});
