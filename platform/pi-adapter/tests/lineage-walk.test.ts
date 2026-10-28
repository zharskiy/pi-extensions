import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import { createFileReader, linkKey, walkLineage } from "../runtime/lineage-walk.ts";

const temp = useTempDirs();

type Link = { file: string; previous?: string };

const walk = (links: Link[], start: string, max?: number) => {
  const byFile = new Map(links.map((link) => [link.file, link]));
  const previousOf = (link: Link) => (link.previous ? byFile.get(link.previous) : undefined);
  const first = byFile.get(start) ?? { file: start };

  const result = walkLineage(first, previousOf, { key: (link) => link.file, max });

  return { files: result.links.map((link) => link.file), truncated: result.truncated };
};

describe("walking a lineage", () => {
  it("yields the links oldest first", () => {
    const links = [{ file: "a" }, { file: "b", previous: "a" }, { file: "c", previous: "b" }];

    expect(walk(links, "c")).toEqual({ files: ["a", "b", "c"], truncated: false });
  });

  it("stops at a link it has already seen and says so", () => {
    const links = [
      { file: "a", previous: "c" },
      { file: "b", previous: "a" },
      { file: "c", previous: "b" },
    ];

    expect(walk(links, "c")).toEqual({ files: ["a", "b", "c"], truncated: true });
  });

  it("keeps the newest links up to the cap and says so", () => {
    const links = ["a", "b", "c", "d"].map((file, index, files) => ({ file, previous: files[index - 1] }));

    expect(walk(links, "d", 2)).toEqual({ files: ["c", "d"], truncated: true });
  });

  it("tells two leaves of one file apart", () => {
    expect(linkKey({ file: "a", leafId: "1" })).not.toBe(linkKey({ file: "a", leafId: "2" }));
    expect(linkKey({ file: "a", leafId: null })).toBe(linkKey({ file: "a" }));
  });
});

describe("reading the file of a link", () => {
  it("reports a missing file as missing and a throwing read as failed", () => {
    const dir = temp.make("pi-lineage-walk-");
    const file = join(dir, "broken.jsonl");

    writeFileSync(file, "x");

    const read = createFileReader(() => {
      throw new Error("bad line");
    });

    expect(read(join(dir, "gone.jsonl"))).toEqual({ status: "missing" });
    expect(read(file)).toEqual({ status: "failed", error: "bad line" });
  });

  it("reads a file again only once its size or time changes", () => {
    const dir = temp.make("pi-lineage-walk-");
    const file = join(dir, "session.jsonl");
    const parse = vi.fn((path: string) => path.length);

    writeFileSync(file, "one\n");

    const read = createFileReader(parse);

    expect(read(file)).toEqual({ status: "read", value: file.length });

    read(file);

    expect(parse).toHaveBeenCalledTimes(1);

    writeFileSync(file, "one\ntwo\n");
    read(file);

    expect(parse).toHaveBeenCalledTimes(2);
  });
});
