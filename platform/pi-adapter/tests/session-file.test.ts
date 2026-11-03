import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useTempDirs } from "../../../test/framework/index.ts";
import {
  parseSessionLines,
  readSessionEntries,
  readSessionHeader,
  readSessionId,
  replaySystemMessages,
} from "../runtime/session-file.ts";

const temp = useTempDirs();

const user = JSON.stringify({ type: "message", message: { role: "user", content: "hi" } });

const RECORD = "x:prompt-record";

describe("session file prompt record", () => {
  it("reads the provider payload of the last prompt record", () => {
    const payload = { model: "provider/model", system: "You are explorer.", tools: [{ name: "read" }] };
    const entry = (data: unknown) => JSON.stringify({ type: "custom", customType: RECORD, data });
    const record = parseSessionLines(
      [entry({ providerPayload: { stale: true } }), entry({ providerPayload: payload }), user],
      RECORD,
    );

    expect(record.providerPayload).toEqual(payload);
  });

  it("has no payload without a prompt record", () => {
    expect(parseSessionLines([user], RECORD).providerPayload).toBeUndefined();
  });

  it("keeps the transcript of an old session file", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "s", cwd: "/repo" }),
      user,
      JSON.stringify({ type: "message", message: { role: "hookMessage", content: "hook" } }),
      JSON.stringify({ type: "compaction", summary: "earlier", firstKeptEntryIndex: 1 }),
      JSON.stringify({ type: "custom_message", customType: "note", content: "noted", display: true }),
      '{"type":"message","message":{"role":"user"',
    ];

    const { items } = parseSessionLines(lines, RECORD);

    expect(items).toEqual([
      { kind: "user", text: "hi" },
      {
        kind: "custom",
        raw: {
          role: "custom",
          customType: "note",
          content: "noted",
          display: true,
          details: undefined,
          timestamp: 0,
        },
      },
    ]);
  });
});

describe("session file entries", () => {
  it("migrates an old session file as pi does", () => {
    const file = join(mkdtempSync(join(tmpdir(), "pi-session-file-")), "old.jsonl");
    const lines = [
      { type: "session", id: "s", cwd: "/repo" },
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "hookMessage", content: "hook" } },
      { type: "compaction", summary: "earlier", firstKeptEntryIndex: 1 },
    ];

    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n"));

    const [, kept, hook, compaction] = readSessionEntries(file) as {
      id?: string;
      message?: { role: string };
      firstKeptEntryId?: string;
      firstKeptEntryIndex?: number;
    }[];

    expect(hook?.message?.role).toBe("custom");
    expect(compaction?.firstKeptEntryId).toBe(kept?.id);
    expect(compaction?.firstKeptEntryIndex).toBeUndefined();
  });
});

describe("system message replay", () => {
  it("applies added and removed sections and tools in order", () => {
    const messages = [
      {
        role: "system",
        sections: { preamble: "You are explorer.", cwd: "Current directory: /repo" },
        toolsAdded: [
          { name: "read", description: "Read a file.", parameters: {} },
          { name: "ls", description: "List a directory.", parameters: {} },
        ],
      },
      { role: "user", sections: { ignored: "x" } },
      { role: "system", sections: { cwd: null }, toolsRemoved: [{ name: "ls" }] },
    ];

    const replay = replaySystemMessages(messages);

    expect([...replay.sections]).toEqual([["preamble", "You are explorer."]]);
    expect([...replay.tools.values()]).toEqual([
      { name: "read", description: "Read a file.", parameters: {} },
    ]);
  });

  it("reads the session id from the header and nothing from a missing or headerless file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-session-id-"));
    const named = join(dir, "renamed.jsonl");
    const headerless = join(dir, "headerless.jsonl");

    writeFileSync(named, `${JSON.stringify({ type: "session", id: "s-1", cwd: "/repo" })}\n`);
    writeFileSync(
      headerless,
      `${JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })}\n`,
    );

    expect([named, headerless, join(dir, "missing.jsonl")].map(readSessionId)).toEqual([
      "s-1",
      undefined,
      undefined,
    ]);
  });

  it("reads the header id and parent from the first line", async () => {
    const dir = temp.make("pi-session-header-");
    const child = join(dir, "child.jsonl");
    const root = join(dir, "root.jsonl");
    const header = { type: "session", version: 3, id: "s-2", cwd: "/repo", parentSession: "/p.jsonl" };

    writeFileSync(child, `${JSON.stringify(header)}\n${user}\n`);
    writeFileSync(root, JSON.stringify({ type: "session", id: "s-1", cwd: "/repo" }));

    expect(await readSessionHeader(child)).toEqual({ header: { id: "s-2", parentSession: "/p.jsonl" } });
    expect(await readSessionHeader(root)).toEqual({ header: { id: "s-1" } });
  });

  it("reads no header from an empty, headerless or blank-first file, or one whose first line passes 64 KiB", async () => {
    const dir = temp.make("pi-session-header-");
    const header = JSON.stringify({ type: "session", id: "s-1", cwd: "x".repeat(64 * 1024) });
    const files = { empty: "", headerless: `${user}\n`, blank: `\n${header}\n`, long: `${header}\n` };

    Object.entries(files).forEach(([name, text]) => {
      writeFileSync(join(dir, name), text);
    });

    const reads = await Promise.all(Object.keys(files).map((name) => readSessionHeader(join(dir, name))));

    expect(reads).toEqual([
      { header: undefined },
      { header: undefined },
      { header: undefined },
      { header: undefined },
    ]);
  });

  it.skipIf(process.getuid?.() === 0)("tells a vanished file from one it cannot read", async () => {
    const dir = temp.make("pi-session-header-");
    const locked = join(dir, "locked.jsonl");

    writeFileSync(locked, `${JSON.stringify({ type: "session", id: "s-1" })}\n`);
    chmodSync(locked, 0o000);

    expect(await readSessionHeader(join(dir, "missing.jsonl"))).toEqual({ gone: true });
    expect(await readSessionHeader(locked)).toEqual({ error: "EACCES" });
  });
});
