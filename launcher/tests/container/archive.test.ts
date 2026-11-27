import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { FILE_FLAGS, numericField, sourceArchive } from "../../container/archive.ts";
import { tempDir } from "../support/temp-dir.ts";

const HOST_TAR = "/usr/bin/tar";

const LONG_FOLDER = "a-folder-whose-name-is-long-enough".repeat(3);

const LONG_TARGET = `${"../".repeat(30)}somewhere/${"x".repeat(40)}`;

const realTemp = async (prefix: string) => realpath(await tempDir(prefix));

const collected = async (stream: Readable) => {
  const chunks: Buffer[] = [];

  stream.on("data", (chunk: Buffer) => chunks.push(chunk));

  await new Promise((resolve) => stream.once("end", resolve));

  return Buffer.concat(chunks);
};

const blocked = async (stream: Readable) => {
  const writable = stream as unknown as { writableNeedDrain: boolean };

  await expect.poll(() => writable.writableNeedDrain, { interval: 5, timeout: 5000 }).toBe(true);
};

const listed = (archive: Buffer) =>
  execFileSync(HOST_TAR, ["-t", "-f", "-"], { input: archive })
    .toString()
    .split("\n")
    .filter((line) => line !== "")
    .sort();

const listedVerbose = (archive: Buffer) =>
  execFileSync(HOST_TAR, ["-t", "-v", "-f", "-"], { input: archive }).toString();

const extracted = async (archive: Buffer) => {
  const into = await realTemp("archive-out");

  execFileSync(HOST_TAR, ["-x", "-p", "-f", "-", "-C", into], { input: archive });

  return into;
};

const modeOf = async (path: string) => (await lstat(path)).mode & 0o777;

const BIG = Buffer.alloc(2 * 1024 * 1024, 7);

describe("sourceArchive, read by the Mac's tar", () => {
  it("carries folders, files and links with long names, permission bits, mtimes and the pi owner", async () => {
    const root = await realTemp("archive-src");
    const deep = join(root, LONG_FOLDER, LONG_FOLDER);

    await mkdir(deep, { recursive: true });

    await writeFile(join(deep, "lib.jar"), "jar");

    await writeFile(join(root, "run.sh"), "#!/bin/sh\n");

    await chmod(join(root, "run.sh"), 0o4755);

    await writeFile(join(root, "private"), "p");

    await chmod(join(root, "private"), 0o640);

    await mkdir(join(root, "locked"));

    await writeFile(join(root, "locked", "inside"), "i");

    await chmod(join(root, "locked"), 0o555);

    await utimes(join(root, "private"), 1_600_000_000, 1_600_000_000);

    await symlink("run.sh", join(root, "short"));

    await symlink(LONG_TARGET, join(root, "far"));

    await symlink("/etc/hosts", join(root, "absolute"));

    await writeFile(join(root, "._run.sh"), "apple double");

    try {
      const archive = sourceArchive(root);
      const bytes = await collected(archive.stream);
      const out = await extracted(bytes);
      const deepOut = join(out, LONG_FOLDER, LONG_FOLDER);

      expect(archive.complete()).toBe(true);
      expect(archive.tally).toEqual({ leftOut: 0, changed: 0 });
      expect(listed(bytes)).toEqual(
        [
          "absolute",
          "far",
          `${LONG_FOLDER}/`,
          `${LONG_FOLDER}/${LONG_FOLDER}/`,
          `${LONG_FOLDER}/${LONG_FOLDER}/lib.jar`,
          "locked/",
          "locked/inside",
          "private",
          "run.sh",
          "short",
        ].sort(),
      );
      expect(listedVerbose(bytes)).toMatch(/ pi +pi /);
      expect(await readFile(join(deepOut, "lib.jar"), "utf8")).toBe("jar");
      expect(await readlink(join(out, "short"))).toBe("run.sh");
      expect(await readlink(join(out, "far"))).toBe(LONG_TARGET);
      expect(await readlink(join(out, "absolute"))).toBe("/etc/hosts");
      expect(await modeOf(join(out, "run.sh"))).toBe(0o755);
      expect(await modeOf(join(out, "private"))).toBe(0o640);
      expect(await modeOf(join(out, "locked"))).toBe(0o755);
      expect((await stat(join(out, "private"))).mtimeMs).toBe(1_600_000_000_000);
    } finally {
      await chmod(join(root, "locked"), 0o755);
    }
  });

  it("writes an mtime past the octal field in base-256, which the reader takes back", async () => {
    const root = await realTemp("archive-src");
    const far = 9_000_000_000;

    await writeFile(join(root, "future"), "f");

    await utimes(join(root, "future"), far, far);

    const out = await extracted(await collected(sourceArchive(root).stream));

    expect(numericField(far, 12)[0]).toBe(0x80);
    expect(numericField(8 * 1024 ** 3, 12)[0]).toBe(0x80);
    expect(numericField(8 * 1024 ** 3 - 1, 12).toString("ascii")).toBe("77777777777\0");
    expect((await stat(join(out, "future"))).mtimeMs).toBe(far * 1000);
  });

  it("leaves out and counts an unreadable file and folder, and leaves out a fifo and a socket uncounted", async () => {
    const root = await realTemp("archive-src");

    await writeFile(join(root, "kept"), "k");

    await writeFile(join(root, "secret"), "s");

    await chmod(join(root, "secret"), 0o000);

    await mkdir(join(root, "closed"));

    await chmod(join(root, "closed"), 0o000);

    execFileSync("/usr/bin/mkfifo", [join(root, "pipe")]);

    const server = createServer();

    await new Promise<void>((resolve) => server.listen(join(root, "s"), resolve));

    try {
      const archive = sourceArchive(root);
      const bytes = await collected(archive.stream);

      expect(archive.complete()).toBe(true);
      expect(archive.tally).toEqual({ leftOut: 2, changed: 0 });
      expect(listed(bytes)).toEqual(["kept"]);
    } finally {
      server.close();

      await chmod(join(root, "closed"), 0o755);
    }
  });

  it("counts a file that vanished and a folder and a file replaced by links after the listing, and follows neither", async () => {
    const parent = await realTemp("archive-swap");
    const root = join(parent, "src");
    const outside = join(parent, "outside");

    await mkdir(join(root, "b-folder"), { recursive: true });

    await mkdir(outside);

    await writeFile(join(outside, "secret"), "outside");

    await writeFile(join(root, "a-big"), BIG);

    await writeFile(join(root, "b-folder", "inside"), "i");

    await writeFile(join(root, "c-file"), "c");

    await writeFile(join(root, "d-gone"), "d");

    const archive = sourceArchive(root);

    await blocked(archive.stream);

    await rename(join(root, "b-folder"), join(parent, "moved"));

    await symlink(outside, join(root, "b-folder"));

    await rm(join(root, "c-file"));

    await symlink(join(outside, "secret"), join(root, "c-file"));

    await rm(join(root, "d-gone"));

    const bytes = await collected(archive.stream);

    expect(archive.complete()).toBe(true);
    expect(archive.tally).toEqual({ leftOut: 3, changed: 0 });
    expect(listed(bytes)).toEqual(["a-big"]);
    expect(bytes.includes(Buffer.from("outside"))).toBe(false);
  });

  it("pads a file that shrinks while it is read to the size in its header and counts it", async () => {
    const root = await realTemp("archive-src");

    await writeFile(join(root, "a-shrinks"), BIG);

    await writeFile(join(root, "b-after"), "b");

    const archive = sourceArchive(root);

    await blocked(archive.stream);

    await truncate(join(root, "a-shrinks"), 10);

    const out = await extracted(await collected(archive.stream));

    expect(archive.tally).toEqual({ leftOut: 0, changed: 1 });
    expect((await stat(join(out, "a-shrinks"))).size).toBe(BIG.length);
    expect(await readFile(join(out, "b-after"), "utf8")).toBe("b");
  });

  it("is not complete when it is stopped before its end", async () => {
    const root = await realTemp("archive-src");

    await writeFile(join(root, "a-big"), BIG);

    const archive = sourceArchive(root);

    await blocked(archive.stream);

    archive.stream.destroy();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(archive.complete()).toBe(false);
  });

  it("opens no file through a linked parent folder", async () => {
    const parent = await realTemp("archive-open");

    await mkdir(join(parent, "real"));

    await writeFile(join(parent, "real", "file"), "f");

    await symlink("real", join(parent, "linked"));

    const plain = await open(join(parent, "linked", "file"), "r");

    await plain.close();

    await expect(open(join(parent, "linked", "file"), FILE_FLAGS)).rejects.toMatchObject({ code: "ELOOP" });
    await expect(open(join(parent, "linked"), FILE_FLAGS)).rejects.toMatchObject({ code: "ELOOP" });
  });
});
