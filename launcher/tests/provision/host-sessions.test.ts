import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readdir, readFile, realpath, stat, symlink, truncate } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareHostSessions, probeHostSessions, sweepHostSessions } from "../../provision/index.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir, writeText } from "./fixtures.ts";

const PRIVATE = 0o700;

const MODE_BITS = 0o777;

const modeOf = async (path: string) => (await stat(path)).mode & MODE_BITS;

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const header = (cwd: string) =>
  `${JSON.stringify({ type: "session", id: "abc", cwd })}\n{"type":"message"}\n`;

const sessionFiles = async (dir: string) =>
  (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const rejectedNotice = (dir: string, name: string, reason: string) =>
  new RegExp(
    `^sessions: ${escaped(join(dir, name))} ${reason}.*; renamed to ${escaped(name)}\\.rejected-[0-9a-f]{8}$`,
  );

const sessionsFixture = async () => {
  const base = await realpath(await tempDir("host-sessions"));
  const repoRoot = join(base, "work", "repo");
  const dir = join(base, "agent", "sessions", "--work-repo--");
  const outside = join(base, "outside.txt");

  await mkdir(repoRoot, { recursive: true });

  await mkdir(dir, { recursive: true });

  await writeText(outside, "secret elsewhere\n");

  return { base, repoRoot, dir, outside };
};

describe("prepareHostSessions", () => {
  it("creates the missing agent, sessions and slug directories with mode 0700", async () => {
    const base = await realpath(await tempDir("prepare"));
    const agentDir = join(base, "home", ".pi", "agent");
    const dir = join(agentDir, "sessions", "--repo--");

    await prepareHostSessions(dir);

    expect(await modeOf(agentDir)).toBe(PRIVATE);
    expect(await modeOf(join(agentDir, "sessions"))).toBe(PRIVATE);
    expect(await modeOf(dir)).toBe(PRIVATE);
  });

  it("never changes the mode of directories that already exist", async () => {
    const base = await realpath(await tempDir("prepare"));
    const sessions = join(base, "agent", "sessions");
    const dir = join(sessions, "--repo--");

    await mkdir(dir, { recursive: true });

    await chmod(sessions, 0o755);

    await chmod(dir, 0o750);

    await prepareHostSessions(dir);

    expect(await modeOf(sessions)).toBe(0o755);
    expect(await modeOf(dir)).toBe(0o750);
  });
});

describe("sweepHostSessions", () => {
  it("removes top-level links and fifos, keeps regular files and leaves link targets alone", async () => {
    const { repoRoot, dir, outside } = await sessionsFixture();

    await writeText(join(dir, "2026_a.jsonl"), header(repoRoot));

    await writeText(join(dir, "notes.txt"), "kept\n");

    await symlink(outside, join(dir, "link.jsonl"));

    await symlink("/etc", join(dir, "linked-dir"));

    execFileSync("sh", ["-c", 'mkfifo "$1"', "sh", join(dir, "hang.jsonl")]);

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect((await readdir(dir)).sort()).toEqual(["2026_a.jsonl", "notes.txt"]);
    expect(await readFile(outside, "utf8")).toBe("secret elsewhere\n");
    expect(notices).toEqual([`sessions: removed 3 links or special files from ${dir}`]);
  });

  it("leaves the agents subtree alone in the top-level sweep and cleans it in the full sweep", async () => {
    const { base, repoRoot, dir, outside } = await sessionsFixture();
    const stem = join(dir, "2026_a");
    const otherAgents = join(base, "other-agents");

    await writeText(join(dir, "2026_a.jsonl"), header(repoRoot));

    await writeText(join(stem, "agents", "one", "run.jsonl"), "{}\n");

    await symlink(outside, join(stem, "agents", "one", "leak.jsonl"));

    await mkdir(otherAgents, { recursive: true });

    await mkdir(join(dir, "2026_b"));

    await symlink(otherAgents, join(dir, "2026_b", "agents"));

    expect((await sweepHostSessions({ dir, repoRoot, full: false })).notices).toEqual([]);
    expect(await exists(join(stem, "agents", "one", "leak.jsonl"))).toBe(true);

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: true });

    expect(await exists(join(stem, "agents", "one", "leak.jsonl"))).toBe(false);
    expect(await exists(join(dir, "2026_b", "agents"))).toBe(false);
    expect(await exists(join(stem, "agents", "one", "run.jsonl"))).toBe(true);
    expect(await exists(otherAgents)).toBe(true);
    expect(await readFile(outside, "utf8")).toBe("secret elsewhere\n");
    expect(notices).toEqual([`sessions: removed 2 links or special files from ${dir}`]);
  });

  it("keeps sessions inside the repository and renames one whose header names a cwd outside it", async () => {
    const { repoRoot, dir } = await sessionsFixture();

    await writeText(join(dir, "root.jsonl"), header(repoRoot));

    await writeText(join(dir, "subdir.jsonl"), header(join(repoRoot, "src")));

    await writeText(join(dir, "foreign.jsonl"), header("/etc"));

    await writeText(join(dir, "relative.jsonl"), header("repo"));

    await writeText(join(dir, "no-cwd.jsonl"), `${JSON.stringify({ type: "session", id: "x" })}\n`);

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual(["root.jsonl", "subdir.jsonl"]);
    expect(notices.sort()).toEqual([
      expect.stringMatching(rejectedNotice(dir, "foreign.jsonl", "names a cwd outside the repository")),
      expect.stringMatching(rejectedNotice(dir, "no-cwd.jsonl", "names a cwd outside the repository")),
      expect.stringMatching(rejectedNotice(dir, "relative.jsonl", "names a cwd outside the repository")),
    ]);
  });

  it("finds the header the way pi does, past blank and malformed lines, and rejects a forged one there", async () => {
    const { repoRoot, dir } = await sessionsFixture();

    await writeText(join(dir, "blank.jsonl"), `\n\n${header("/etc")}`);

    await writeText(join(dir, "malformed.jsonl"), `garbage\n{"half":\nnull\n${header("/etc")}`);

    await writeText(join(dir, "carriage.jsonl"), `garbage\r${header("/etc")}`);

    await writeText(join(dir, "late.jsonl"), `\n  \n${header(repoRoot)}`);

    await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual(["late.jsonl"]);
  });

  it("rejects a bare carriage return before the header, which pi's listing and opening split differently", async () => {
    const { repoRoot, dir } = await sessionsFixture();
    const inside = JSON.stringify({ type: "session", id: "b", cwd: repoRoot });

    await writeText(
      join(dir, "a.jsonl"),
      `{"type":"session","id":"a",\r"cwd":"/foreign","timestamp":"2026-01-01T00:00:00Z"}\n${inside}\n`,
    );

    await writeText(
      join(dir, "b.jsonl"),
      '{"type":"session","id":"a","cwd":"/foreign","x":\r{"type":"note"}\r}\n',
    );

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual([]);
    expect(notices.sort()).toEqual([
      expect.stringMatching(
        rejectedNotice(dir, "a.jsonl", "has a bare carriage return before its session header"),
      ),
      expect.stringMatching(
        rejectedNotice(dir, "b.jsonl", "has a bare carriage return before its session header"),
      ),
    ]);
  });

  it("reads CRLF session files as before", async () => {
    const { repoRoot, dir } = await sessionsFixture();
    const crlf = (cwd: string) =>
      `${JSON.stringify({ type: "session", id: "c", cwd })}\r\n{"type":"message"}\r\n`;

    await writeText(join(dir, "inside.jsonl"), `\r\n${crlf(repoRoot)}`);

    await writeText(join(dir, "foreign.jsonl"), crlf("/etc"));

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual(["inside.jsonl"]);
    expect(notices).toEqual([
      expect.stringMatching(rejectedNotice(dir, "foreign.jsonl", "names a cwd outside the repository")),
    ]);
  });

  it("restores owner access to a read-only session dir and subdirectory before acting", async () => {
    const { repoRoot, dir, outside } = await sessionsFixture();
    const agents = join(dir, "run", "agents");

    await writeText(join(dir, "foreign.jsonl"), header("/etc"));

    await mkdir(agents, { recursive: true });

    await symlink(outside, join(agents, "leak.jsonl"));

    await chmod(agents, 0o500);

    await chmod(dir, 0o500);

    const { failures } = await sweepHostSessions({ dir, repoRoot, full: true });

    expect(failures).toEqual([]);
    expect(await sessionFiles(dir)).toEqual([]);
    expect(await readdir(agents)).toEqual([]);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform !== "darwin")(
    "reports a file it can neither rename nor delete, even after restoring access",
    async () => {
      const { repoRoot, dir } = await sessionsFixture();
      const pinned = join(dir, "pinned.jsonl");

      await writeText(pinned, header("/etc"));

      execFileSync("sh", ["-c", 'chflags uchg "$1"', "sh", pinned]);

      try {
        const { failures } = await sweepHostSessions({ dir, repoRoot, full: false });

        expect(failures).toEqual([
          `${pinned} is a session file that names a cwd outside the repository and could be neither renamed nor deleted`,
        ]);
      } finally {
        execFileSync("sh", ["-c", 'chflags nouchg "$1"', "sh", pinned]);
      }
    },
  );

  it("fails closed on a header line longer than 1 MiB, wherever its cwd points", async () => {
    const { repoRoot, dir } = await sessionsFixture();
    const pad = "x".repeat(1024 * 1024 + 10);

    await writeText(
      join(dir, "long-foreign.jsonl"),
      `${JSON.stringify({ type: "session", id: "a", pad, cwd: "/etc" })}\n`,
    );

    await writeText(
      join(dir, "long-inside.jsonl"),
      `${JSON.stringify({ type: "session", id: "b", pad, cwd: repoRoot })}\n`,
    );

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual([]);
    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.includes("has no session header within 1 MiB"))).toBe(true);
  });

  it("still takes a session out of pi's list when a directory already holds the .rejected name", async () => {
    const { repoRoot, dir } = await sessionsFixture();

    await writeText(join(dir, "x.jsonl"), header("/etc"));

    await mkdir(join(dir, "x.jsonl.rejected"));

    await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual([]);
    expect((await readdir(dir)).some((name) => /^x\.jsonl\.rejected-[0-9a-f]{8}$/.test(name))).toBe(true);
  });

  it("fails closed on a session file it cannot read, with a notice", async () => {
    const { repoRoot, dir } = await sessionsFixture();
    const locked = join(dir, "locked.jsonl");

    await writeText(locked, header(repoRoot));

    await chmod(locked, 0o000);

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual([]);
    expect(notices).toEqual([
      expect.stringMatching(rejectedNotice(dir, "locked.jsonl", "could not be read \\(")),
    ]);
  });

  it("keeps files pi would not list: no session entry first, empty, or a header still being written", async () => {
    const { repoRoot, dir } = await sessionsFixture();

    await writeText(join(dir, "other.jsonl"), `{"type":"message"}\n${header("/etc")}`);

    await writeText(join(dir, "empty.jsonl"), "");

    await writeText(join(dir, "partial.jsonl"), '{"type":"session","id":"x","cwd":"/e');

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual(["empty.jsonl", "other.jsonl", "partial.jsonl"]);
    expect(notices).toEqual([]);
  });

  it("checks many sessions in one sweep", async () => {
    const { repoRoot, dir } = await sessionsFixture();
    const names = Array.from({ length: 40 }, (_, index) => `s${String(index).padStart(2, "0")}.jsonl`);

    await Promise.all(
      names.map((name, index) => writeText(join(dir, name), header(index % 2 === 0 ? repoRoot : "/etc"))),
    );

    await sweepHostSessions({ dir, repoRoot, full: false });

    expect(await sessionFiles(dir)).toEqual(names.filter((_, index) => index % 2 === 0));
  });

  it("warns about a top-level file over 256 MiB and keeps it", async () => {
    const { repoRoot, dir } = await sessionsFixture();
    const big = join(dir, "big.jsonl");

    await writeText(big, header(repoRoot));

    await truncate(big, 257 * 1024 * 1024);

    const { notices } = await sweepHostSessions({ dir, repoRoot, full: false });

    expect(notices).toEqual([`sessions: ${big} is over 256 MiB`]);
    expect(await exists(big)).toBe(true);
  });

  it("does nothing when the directory is missing or is itself a symlink", async () => {
    const { base, repoRoot, outside } = await sessionsFixture();
    const target = join(base, "target");
    const linked = join(base, "agent", "sessions", "--linked--");

    await mkdir(target);

    await symlink(outside, join(target, "link.jsonl"));

    await symlink(target, linked);

    expect(await sweepHostSessions({ dir: join(base, "missing"), repoRoot, full: true })).toEqual({
      notices: [],
      failures: [],
    });
    expect(await sweepHostSessions({ dir: linked, repoRoot, full: true })).toEqual({
      notices: [],
      failures: [],
    });
    expect(await exists(join(target, "link.jsonl"))).toBe(true);
  });
});

const probe = async (fake: ReturnType<typeof createFakeBackend>, dir: string) =>
  probeHostSessions(fake.backend, await runningContainer(fake.backend), dir);

const sharedContainer = (dir: string, seen: string = dir) =>
  createFakeBackend({
    exec: (spec) => {
      const [file = "sh", ...args] = spec.command;
      const result = spawnSync(file, args, { env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: seen } });

      return result.status ?? 1;
    },
  });

describe("probeHostSessions", () => {
  it("passes when the container sees the host marker at its session dir and can write there, and leaves nothing", async () => {
    const { dir } = await sessionsFixture();

    expect(await probe(sharedContainer(dir), dir)).toBe(true);
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails when the container's session dir variable points elsewhere", async () => {
    const { base, dir } = await sessionsFixture();

    expect(await probe(sharedContainer(dir, join(base, "elsewhere")), dir)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it("fails when the container cannot see the marker, and removes it", async () => {
    const { dir } = await sessionsFixture();
    const fake = createFakeBackend({ exec: () => 1 });

    expect(await probe(fake, dir)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it("removes the marker when the exec itself throws", async () => {
    const { dir } = await sessionsFixture();
    const fake = createFakeBackend({
      exec: () => {
        throw new Error("exec failed");
      },
    });

    await expect(probe(fake, dir)).rejects.toThrow("exec failed");
    expect(await readdir(dir)).toEqual([]);
  });
});
