import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostAgentDir } from "../../shared/index.ts";
import {
  assertHostSessionsDir,
  hostSessionsChoice,
  hostSessionsDir,
  sessionsSwitchNotice,
} from "../../workspace/index.ts";
import { sessionSlug } from "../../workspace/pi-session-dir.ts";
import { tempDir } from "../support/temp-dir.ts";

const createAgentDir = async () => {
  const base = await realpath(await tempDir("sessions"));
  const home = join(base, "home");
  const agentDir = join(home, ".pi", "agent");
  const repoRoot = join(base, "work", "repo");

  await mkdir(join(agentDir, "sessions"), { recursive: true });

  await mkdir(repoRoot, { recursive: true });

  return { base, home, agentDir, repoRoot, dir: hostSessionsDir(agentDir, repoRoot) };
};

const choiceWith = (overrides: Partial<Parameters<typeof hostSessionsChoice>[0]> = {}) =>
  hostSessionsChoice({
    enabled: true,
    home: "/Users/dev",
    env: {},
    repoRoot: "/Users/dev/work/repo",
    ...overrides,
  });

describe("sessionSlug", () => {
  it("copies pi's formula: the resolved path without its leading separator, separators and colons as dashes", () => {
    expect(sessionSlug("/Users/dev/work/repo")).toBe("--Users-dev-work-repo--");
    expect(sessionSlug("/srv/a:b/c")).toBe("--srv-a-b-c--");
    expect(sessionSlug("/srv/x/../repo/")).toBe("--srv-repo--");
    expect(sessionSlug("/")).toBe("----");
  });

  it("gives /a/b-c and /a/b/c the same slug, as pi does", () => {
    expect(sessionSlug("/a/b-c")).toBe(sessionSlug("/a/b/c"));
  });
});

describe("hostAgentDir and hostSessionsDir", () => {
  it("uses ~/.pi/agent unless PI_CODING_AGENT_DIR names another directory", () => {
    expect(hostAgentDir("/Users/dev", {})).toBe("/Users/dev/.pi/agent");
    expect(hostAgentDir("/Users/dev", { PI_CODING_AGENT_DIR: "" })).toBe("/Users/dev/.pi/agent");
    expect(hostAgentDir("/Users/dev", { PI_CODING_AGENT_DIR: "~/pi-agent" })).toBe("/Users/dev/pi-agent");
    expect(hostAgentDir("/Users/dev", { PI_CODING_AGENT_DIR: "file:///srv/pi%20agent" })).toBe(
      "/srv/pi agent",
    );
  });

  it("puts the repository's sessions one level under the agent dir's sessions", () => {
    expect(hostSessionsDir("/Users/dev/.pi/agent", "/Users/dev/work/repo")).toBe(
      "/Users/dev/.pi/agent/sessions/--Users-dev-work-repo--",
    );
  });
});

describe("hostSessionsChoice", () => {
  it("chooses the repository's host session directory by default", () => {
    expect(choiceWith()).toEqual({ dir: "/Users/dev/.pi/agent/sessions/--Users-dev-work-repo--" });
  });

  it("stays in the volume without a notice when sessions.host or PI_SANDBOX_SESSIONS_HOST is off", () => {
    expect(choiceWith({ enabled: false })).toEqual({ off: "sessions.host is off", notice: false });
    expect(choiceWith({ env: { PI_SANDBOX_SESSIONS_HOST: "off" } })).toEqual({
      off: "PI_SANDBOX_SESSIONS_HOST is off",
      notice: false,
    });
  });

  it("stays in the volume with a notice when host pi uses a custom session dir", () => {
    const custom = { off: "host pi uses a custom session dir", notice: true };

    expect(choiceWith({ env: { PI_CODING_AGENT_SESSION_DIR: "/shared/sessions" } })).toEqual(custom);
    expect(choiceWith({ settings: { sessionDir: "~/sessions" } })).toEqual(custom);
    expect(choiceWith({ env: { PI_CODING_AGENT_SESSION_DIR: " " } })).toEqual(custom);
    expect(choiceWith({ settings: { sessionDir: " " } })).toEqual(custom);
    expect(choiceWith({ env: { PI_CODING_AGENT_SESSION_DIR: "" } })).toEqual({
      dir: "/Users/dev/.pi/agent/sessions/--Users-dev-work-repo--",
    });
    expect(choiceWith({ settings: { sessionDir: "" } })).toEqual({
      dir: "/Users/dev/.pi/agent/sessions/--Users-dev-work-repo--",
    });
  });

  it("stays in the volume with a notice when the host agent dir is the sandbox's own agent path", () => {
    expect(choiceWith({ home: "/home/pi", repoRoot: "/home/pi/repo" })).toEqual({
      off: "the host agent directory is the sandbox's own agent path",
      notice: true,
    });
  });
});

describe("sessionsSwitchNotice", () => {
  it("says an unknown PI_SANDBOX_SESSIONS_HOST value is ignored, and leaves the feature on", () => {
    expect(sessionsSwitchNotice({ PI_SANDBOX_SESSIONS_HOST: "0" })).toBe(
      'sessions: PI_SANDBOX_SESSIONS_HOST=0 is not "off" and is ignored',
    );
    expect(sessionsSwitchNotice({ PI_SANDBOX_SESSIONS_HOST: "off" })).toBeUndefined();
    expect(sessionsSwitchNotice({})).toBeUndefined();
    expect("dir" in choiceWith({ env: { PI_SANDBOX_SESSIONS_HOST: "false" } })).toBe(true);
  });
});

describe("assertHostSessionsDir", () => {
  it("accepts exactly the repository's real session directory", async () => {
    const { home, agentDir, repoRoot, dir } = await createAgentDir();

    await mkdir(dir);

    expect(() => assertHostSessionsDir(dir, { home, agentDir, repoRoot })).not.toThrow();
  });

  it("refuses the agent dir, its sessions dir, a sibling, another repository's slug and a nested path", async () => {
    const { home, agentDir, repoRoot, dir } = await createAgentDir();

    await mkdir(join(dir, "nested"), { recursive: true });

    const refused = [
      agentDir,
      join(agentDir, "sessions"),
      join(agentDir, "auth.json"),
      join(agentDir, "extensions"),
      join(agentDir, "sessions", "--other--"),
      join(dir, "nested"),
      join(agentDir, ".."),
    ];

    refused.forEach((path) => {
      expect(() => assertHostSessionsDir(path, { home, agentDir, repoRoot })).toThrow(
        "is not pi's session directory of this repository",
      );
    });
  });

  it("refuses a symlink, a missing directory and a file", async () => {
    const { base, home, agentDir, repoRoot, dir } = await createAgentDir();

    expect(() => assertHostSessionsDir(dir, { home, agentDir, repoRoot })).toThrow("is not a real directory");

    await writeFile(dir, "");

    expect(() => assertHostSessionsDir(dir, { home, agentDir, repoRoot })).toThrow("is not a real directory");

    await rm(dir);

    await mkdir(join(base, "elsewhere"));

    await symlink(join(base, "elsewhere"), dir);

    expect(() => assertHostSessionsDir(dir, { home, agentDir, repoRoot })).toThrow(
      `sessions: ${dir} is not a real directory, refusing to mount it into the sandbox`,
    );
  });

  it("accepts a sessions dir that is itself a symlink, as host pi follows it too", async () => {
    const { base, home, agentDir, repoRoot } = await createAgentDir();
    const moved = join(base, "moved-sessions");

    await rm(join(agentDir, "sessions"), { recursive: true });

    await mkdir(join(moved, sessionSlug(repoRoot)), { recursive: true });

    await symlink(moved, join(agentDir, "sessions"));

    const dir = hostSessionsDir(agentDir, repoRoot);

    expect(() => assertHostSessionsDir(dir, { home, agentDir, repoRoot })).not.toThrow();
  });

  it("refuses a symlinked sessions dir that resolves into another entry of the agent dir", async () => {
    const { home, agentDir, repoRoot } = await createAgentDir();
    const extensions = join(agentDir, "extensions");

    await rm(join(agentDir, "sessions"), { recursive: true });

    await mkdir(join(extensions, sessionSlug(repoRoot)), { recursive: true });

    await symlink(extensions, join(agentDir, "sessions"));

    const dir = hostSessionsDir(agentDir, repoRoot);

    expect(() => assertHostSessionsDir(dir, { home, agentDir, repoRoot })).toThrow(
      `resolves to a path that overlaps ${extensions}`,
    );
  });
});
