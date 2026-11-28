import { once } from "node:events";
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";

const O_NOFOLLOW_ANY = 0x20000000;

const FOLDER_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | O_NOFOLLOW_ANY;

export const FILE_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY;

const BLOCK = 512;

const CHUNK = 256 * 1024;

const NAME_FIELD = 100;

const OWNER_ID = 1000;

const OWNER_NAME = "pi";

const PERMISSION_BITS = 0o777;

const FOLDER_OWNER_BITS = 0o700;

const LONG_NAME = Buffer.from("././@LongLink");

const GNU_MAGIC = "ustar  \0";

type EntryType = "0" | "2" | "5" | "K" | "L";

interface Header {
  name: Buffer;
  type: EntryType;
  size: number;
  mode: number;
  mtime: number;
  link?: Buffer;
}

export interface ArchiveTally {
  leftOut: number;
  changed: number;
}

export interface SourceArchive {
  stream: Readable;
  tally: ArchiveTally;
  complete: () => boolean;
  failure: () => string | undefined;
}

type Write = (chunk: Buffer) => Promise<void>;

interface Walk {
  write: Write;
  tally: ArchiveTally;
}

interface LinkEntry {
  name: string;
  target: Buffer;
  mtime: number;
}

interface Listing {
  stats: Stats;
  entries: Dirent[];
  links: Map<string, LinkEntry | undefined>;
}

class ArchiveStopped extends Error {}

export const numericField = (value: number, length: number) => {
  const field = Buffer.alloc(length);
  const whole = Math.max(0, Math.trunc(value));
  const octal = whole.toString(8);

  if (octal.length < length) {
    field.write(octal.padStart(length - 1, "0"), "ascii");

    return field;
  }

  const big = BigInt(whole);

  field[0] = 0x80;

  Array.from({ length: length - 1 }).forEach((_, index) => {
    field[length - 1 - index] = Number((big >> BigInt(8 * index)) & 0xffn);
  });

  return field;
};

const headerBlock = (header: Header) => {
  const block = Buffer.alloc(BLOCK);

  header.name.copy(block, 0, 0, NAME_FIELD);

  numericField(header.mode, 8).copy(block, 100);

  numericField(OWNER_ID, 8).copy(block, 108);

  numericField(OWNER_ID, 8).copy(block, 116);

  numericField(header.size, 12).copy(block, 124);

  numericField(header.mtime, 12).copy(block, 136);

  block.fill(0x20, 148, 156);

  block.write(header.type, 156, "ascii");

  header.link?.copy(block, 157, 0, NAME_FIELD);

  block.write(GNU_MAGIC, 257, "binary");

  block.write(OWNER_NAME, 265, "ascii");

  block.write(OWNER_NAME, 297, "ascii");

  const sum = block.reduce((total, byte) => total + byte, 0);

  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");

  return block;
};

const paddingOf = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

const longEntry = (type: "K" | "L", value: Buffer) => {
  const data = Buffer.concat([value, Buffer.alloc(1)]);
  const header = headerBlock({ name: LONG_NAME, type, size: data.length, mode: 0, mtime: 0 });

  return [header, data, paddingOf(data.length)];
};

const entryBlocks = (header: Header) => {
  const longName = header.name.length > NAME_FIELD ? longEntry("L", header.name) : [];
  const longLink =
    header.link !== undefined && header.link.length > NAME_FIELD ? longEntry("K", header.link) : [];

  return Buffer.concat([...longLink, ...longName, headerBlock(header)]);
};

const secondsOf = (stats: Stats) => Math.floor(stats.mtimeMs / 1000);

const isCopied = (entry: Dirent) =>
  (entry.isFile() || entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("._");

const memberName = (folder: string, name: string) => (folder === "" ? name : `${folder}/${name}`);

const folderStats = async (path: string) => {
  const handle = await open(path, FOLDER_FLAGS);

  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
};

const isSameFolder = (first: Stats, second: Stats) => first.dev === second.dev && first.ino === second.ino;

const linkEntry = async (path: string, name: string): Promise<LinkEntry | undefined> => {
  try {
    const stats = await lstat(path);
    const target = await readlink(path, { encoding: "buffer" });

    return stats.isSymbolicLink() ? { name, target, mtime: secondsOf(stats) } : undefined;
  } catch {
    return undefined;
  }
};

const listFolder = async (path: string): Promise<Listing> => {
  const stats = await folderStats(path);
  const entries = (await readdir(path, { withFileTypes: true }))
    .filter(isCopied)
    .sort((first, second) => (first.name < second.name ? -1 : 1));
  const links = await Promise.all(
    entries
      .filter((entry) => entry.isSymbolicLink())
      .map(async (entry) => [entry.name, await linkEntry(join(path, entry.name), entry.name)] as const),
  );
  const again = await folderStats(path);

  if (!isSameFolder(stats, again)) {
    throw new Error("the folder changed while it was read");
  }

  return { stats, entries, links: new Map(links) };
};

const readInto = async (handle: FileHandle, size: number, write: Write) => {
  let copied = 0;

  while (copied < size) {
    const buffer = Buffer.alloc(Math.min(CHUNK, size - copied));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, copied).catch(() => ({ bytesRead: 0 }));

    if (bytesRead === 0) {
      return copied;
    }

    await write(buffer.subarray(0, bytesRead));

    copied += bytesRead;
  }

  return copied;
};

const padWith = async (missing: number, write: Write) => {
  let left = missing;

  while (left > 0) {
    const zeros = Buffer.alloc(Math.min(CHUNK, left));

    await write(zeros);

    left -= zeros.length;
  }
};

const hasMore = async (handle: FileHandle, size: number) => {
  const probe = await handle.read(Buffer.alloc(1), 0, 1, size).catch(() => ({ bytesRead: 0 }));

  return probe.bytesRead > 0;
};

const fileEntry = async (walk: Walk, path: string, name: string) => {
  const handle = await open(path, FILE_FLAGS).catch(() => undefined);

  if (handle === undefined) {
    walk.tally.leftOut += 1;

    return;
  }

  try {
    const stats = await handle.stat();

    if (!stats.isFile()) {
      walk.tally.leftOut += 1;

      return;
    }

    const header = { name: Buffer.from(name), type: "0" as const, size: stats.size };

    await walk.write(entryBlocks({ ...header, mode: stats.mode & PERMISSION_BITS, mtime: secondsOf(stats) }));

    const copied = await readInto(handle, stats.size, walk.write);

    await padWith(stats.size - copied, walk.write);

    await walk.write(paddingOf(stats.size));

    if (copied < stats.size || (await hasMore(handle, stats.size))) {
      walk.tally.changed += 1;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
};

const linkBlocks = (link: LinkEntry, folder: string) =>
  entryBlocks({
    name: Buffer.from(memberName(folder, link.name)),
    type: "2",
    size: 0,
    mode: PERMISSION_BITS,
    mtime: link.mtime,
    link: link.target,
  });

const leftOutOn = (walk: Walk) => (error: unknown) => {
  if (error instanceof ArchiveStopped) {
    throw error;
  }

  walk.tally.leftOut += 1;

  return undefined;
};

const memberBlocks = async (walk: Walk, root: string, folder: string, listing: Listing, entry: Dirent) => {
  const name = memberName(folder, entry.name);

  if (entry.isDirectory()) {
    await folderMember(walk, root, name);

    return;
  }

  if (entry.isFile()) {
    await fileEntry(walk, join(root, name), name);

    return;
  }

  const link = listing.links.get(entry.name);

  if (link === undefined) {
    walk.tally.leftOut += 1;

    return;
  }

  await walk.write(linkBlocks(link, folder));
};

const folderEntries = async (walk: Walk, root: string, folder: string, listing: Listing) =>
  listing.entries.reduce(async (previous, entry) => {
    await previous;

    await memberBlocks(walk, root, folder, listing, entry).catch(leftOutOn(walk));
  }, Promise.resolve());

const folderMember = async (walk: Walk, root: string, folder: string): Promise<void> => {
  const listing = await listFolder(join(root, folder)).catch(leftOutOn(walk));

  if (listing === undefined) {
    return;
  }

  const mode = (listing.stats.mode & PERMISSION_BITS) | FOLDER_OWNER_BITS;
  const header = { name: Buffer.from(`${folder}/`), type: "5" as const, size: 0 };

  await walk.write(entryBlocks({ ...header, mode, mtime: secondsOf(listing.stats) }));

  await folderEntries(walk, root, folder, listing);
};

const writerOf =
  (output: PassThrough): Write =>
  async (chunk) => {
    if (output.destroyed) {
      throw new ArchiveStopped();
    }

    if (output.write(chunk)) {
      return;
    }

    await Promise.race([once(output, "drain"), once(output, "close")]);
  };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const sourceArchive = (root: string): SourceArchive => {
  const output = new PassThrough();
  const tally = { leftOut: 0, changed: 0 };
  const state: { written: boolean; ended: boolean; failure?: string } = { written: false, ended: false };
  const walk = { write: writerOf(output), tally };

  const produce = async () => {
    const listing = await listFolder(root);

    await folderEntries(walk, root, "", listing);

    await walk.write(Buffer.alloc(BLOCK * 2));

    state.written = true;
  };

  output.once("end", () => {
    state.ended = true;
  });

  output.on("error", () => undefined);

  void produce()
    .catch((error: unknown) => {
      state.failure = error instanceof ArchiveStopped ? "the archive was stopped" : errorText(error);
    })
    .finally(() => output.end());

  return {
    stream: output,
    tally,
    complete: () => state.written && state.ended,
    failure: () => state.failure,
  };
};
