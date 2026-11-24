import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecSpec } from "../../backend/index.ts";
import { installPackages, isPiOffline } from "../../provision/index.ts";
import { INSTALL_COMMAND, LIST_COMMAND, parsePiList } from "../../provision/package-install.ts";
import { createFakeBackend } from "../support/fake-backend.ts";
import { runningContainer, tempDir } from "./fixtures.ts";

const BOLD = (text: string) => `\u001b[1m${text}\u001b[22m`;

const DIM = (text: string) => `\u001b[2m${text}\u001b[22m`;

const LISTED = [
  BOLD("User packages:"),
  "  npm:@scope/tool@1.2.3",
  DIM("    /home/pi/.pi/agent/npm/node_modules/@scope/tool"),
  "  git:github.com/owner/repo@0123456789abcdef0123456789abcdef01234567 (filtered)",
  "  https://user:secret@example.com/team/ext.git@main",
  "  /workspace/local-pkg",
  "",
  BOLD("Project packages:"),
  "  npm:project-only@1.0.0",
  "",
].join("\n");

const INSTALLED = [
  BOLD("User packages:"),
  "  npm:tool@1.1.0",
  DIM("    /home/pi/.pi/agent/npm/node_modules/tool"),
  "",
].join("\n");

const MISSING_WARNING =
  'Warning: Extension package "https://user:secret@example.com/team/ext.git@main": failed to install (git clone https://user:secret@example.com/team/ext.git exited with 128). Run "pi remove https://user:secret@example.com/team/ext.git@main" to remove it from settings.json.';

interface Answer {
  code?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
}

const setup = async (answers: Answer[]) => {
  const queue = [...answers];
  const fake = createFakeBackend({
    exec: async (spec: ExecSpec, io) => {
      if (spec.command[0] !== "timeout") {
        return undefined;
      }

      const answer = queue.shift() ?? {};

      if (answer.hang === true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      io.stdout.write(answer.stdout ?? "");

      io.stderr.write(answer.stderr ?? "");

      return answer.code ?? 0;
    },
  });
  const containerId = await runningContainer(fake.backend);
  const failedPath = join(await tempDir("package-install"), "install-failed.json");
  const announced: string[] = [];
  const install = (overrides: Partial<Parameters<typeof installPackages>[0]> = {}) =>
    installPackages({
      backend: fake.backend,
      containerId,
      env: { HTTPS_PROXY: "http://proxy:3128" },
      packages: { sources: ["npm:tool@1.1.0"], changed: [] },
      failedPath,
      offline: false,
      announce: (notice) => announced.push(notice),
      ...overrides,
    });
  const commands = () =>
    fake.execs.filter((exec) => exec.spec.command[0] === "timeout").map((exec) => exec.spec.command);

  const answer = (...more: Answer[]) => queue.push(...more);

  return { fake, install, announced, commands, answer, failedPath };
};

describe("parsePiList", () => {
  it("reads both sections, strips styling and the filter mark, and sees which are installed", () => {
    expect(parsePiList(LISTED)).toEqual({
      user: [
        { source: "npm:@scope/tool@1.2.3", installed: true },
        { source: "git:github.com/owner/repo@0123456789abcdef0123456789abcdef01234567", installed: false },
        { source: "https://user:secret@example.com/team/ext.git@main", installed: false },
        { source: "/workspace/local-pkg", installed: false },
      ],
      project: [{ source: "npm:project-only@1.0.0", installed: false }],
    });
  });

  it("reads an empty list and refuses text it does not know", () => {
    expect(parsePiList(`${DIM("No packages installed.")}\n`)).toEqual({ user: [], project: [] });
    expect(parsePiList("")).toBeUndefined();
    expect(parsePiList("Error: something broke\n")).toBeUndefined();
  });
});

describe("isPiOffline", () => {
  it("follows PI_OFFLINE as pi reads it and the --offline flag", () => {
    expect(isPiOffline({ PI_OFFLINE: "1" }, [])).toBe(true);
    expect(isPiOffline({ PI_OFFLINE: "Yes" }, [])).toBe(true);
    expect(isPiOffline({ PI_OFFLINE: "0" }, [])).toBe(false);
    expect(isPiOffline({}, ["--offline"])).toBe(true);
    expect(isPiOffline({}, [])).toBe(false);
  });
});

describe("installPackages", () => {
  it("lists once and installs nothing when every remote source is installed", async () => {
    const env = await setup([{ stdout: INSTALLED }]);

    expect(await env.install()).toEqual([]);
    expect(env.commands()).toEqual([LIST_COMMAND]);
    expect(env.announced).toEqual([]);

    const spec = env.fake.execs.at(-1)?.spec;

    expect(spec?.workdir).toBe("/");
    expect(spec?.env).toEqual({ HTTPS_PROXY: "http://proxy:3128" });
  });

  it("installs a missing source, checks again and says nothing when it landed", async () => {
    const listed = [BOLD("User packages:"), "  npm:tool@1.1.0", ""].join("\n");
    const env = await setup([{ stdout: listed }, { code: 0 }, { stdout: INSTALLED }]);

    expect(await env.install()).toEqual([]);
    expect(env.commands()).toEqual([LIST_COMMAND, INSTALL_COMMAND, LIST_COMMAND]);
    expect(env.announced).toEqual([
      "installing 1 extension in the shared pi folder; this can take a few minutes",
    ]);
  });

  it("installs when the host moved an npm pin, though the old version is still on disk", async () => {
    const env = await setup([{ stdout: INSTALLED }, { code: 0 }]);

    expect(await env.install({ packages: { sources: ["npm:tool@1.1.0"], changed: ["npm:tool"] } })).toEqual(
      [],
    );
    expect(env.commands()).toEqual([LIST_COMMAND, INSTALL_COMMAND]);
    expect(env.announced).toEqual([
      "installing 1 extension in the shared pi folder; this can take a few minutes",
    ]);
  });

  it("names each source still missing, without its credentials, and lets the launch go on", async () => {
    const env = await setup([
      { stdout: LISTED },
      { code: 0, stderr: `${MISSING_WARNING}\n` },
      { stdout: LISTED },
    ]);
    const notices = await env.install({
      packages: {
        sources: ["npm:@scope/tool@1.2.3", "https://user:secret@example.com/team/ext.git@main"],
        changed: [],
      },
    });

    expect(env.announced).toEqual([
      "installing 2 extensions in the shared pi folder; this can take a few minutes",
    ]);
    expect(notices).toEqual([
      "warning: git:github.com/owner/repo@0123456789abcdef0123456789abcdef01234567 could not be installed in the shared pi folder; pi tries again when it starts",
      "warning: https://example.com/team/ext.git@main could not be installed in the shared pi folder (git clone https://example.com/team/ext.git exited with 128); pi tries again when it starts",
    ]);
    expect(notices.join("\n")).not.toContain("secret");
  });

  it("ignores local paths and project packages", async () => {
    const listed = [
      BOLD("User packages:"),
      "  /workspace/local-pkg",
      "  ./relative",
      "",
      BOLD("Project packages:"),
      "  npm:project-only@1.0.0",
    ].join("\n");
    const env = await setup([{ stdout: listed }]);

    expect(await env.install({ packages: { sources: ["npm:x@1.0.0"], changed: [] } })).toEqual([]);
    expect(env.commands()).toEqual([LIST_COMMAND]);
  });

  it("reads a source as remote by pi's own case-sensitive prefixes", async () => {
    const listed = [
      BOLD("User packages:"),
      "  NPM:tool@1.0.0",
      "  Git:github.com/owner/repo",
      "  HTTPS://example.com/team/ext.git",
      "  SSH://git@example.com/team/ext.git",
      "",
    ].join("\n");
    const env = await setup([{ stdout: listed }]);

    expect(await env.install({ packages: { sources: ["NPM:tool@1.0.0", "Git:x/y"], changed: [] } })).toEqual(
      [],
    );
    expect(await env.install({ packages: undefined })).toEqual([]);
    expect(env.commands()).toEqual([LIST_COMMAND]);
  });

  it("checks for a git source that pi trims, and for an npm one only as written", async () => {
    const env = await setup([{ stdout: INSTALLED }]);

    expect(await env.install({ packages: { sources: [" npm:tool@1.0.0"], changed: [] } })).toEqual([]);
    expect(env.commands()).toEqual([]);
    expect(await env.install({ packages: { sources: [" git:github.com/owner/repo"], changed: [] } })).toEqual(
      [],
    );
    expect(env.commands()).toEqual([LIST_COMMAND]);
  });

  it("runs nothing offline or without a remote source", async () => {
    const env = await setup([]);

    expect(await env.install({ offline: true })).toEqual([]);
    expect(await env.install({ packages: { sources: ["/workspace/local-pkg"], changed: [] } })).toEqual([]);
    expect(env.commands()).toEqual([]);
  });

  it("checks the list when the sync could not say what it wrote", async () => {
    const env = await setup([{ stdout: INSTALLED }]);

    expect(await env.install({ packages: undefined })).toEqual([]);
    expect(env.commands()).toEqual([LIST_COMMAND]);
  });

  it("turns a failed install or a timeout in the sandbox into one notice", async () => {
    const listed = [BOLD("User packages:"), "  npm:tool@1.1.0", ""].join("\n");
    const failed = await setup([{ stdout: listed }, { code: 1 }]);
    const timedOut = await setup([{ stdout: listed }, { code: 124 }]);

    expect(await failed.install()).toEqual([
      "warning: the extensions were not installed in the shared pi folder (pi exited with 1); pi tries again when it starts",
    ]);
    expect(await timedOut.install()).toEqual([
      "warning: the extensions were not installed in the shared pi folder (pi did not finish within 10 minutes); pi tries again when it starts",
    ]);
    expect(timedOut.commands()).toEqual([LIST_COMMAND, INSTALL_COMMAND]);
  });

  it("turns a list that fails, hangs or prints nonsense into one notice", async () => {
    const failed = await setup([{ code: 2 }]);
    const garbled = await setup([{ stdout: "boom" }]);
    const hung = await setup([{ hang: true }]);

    expect(await failed.install()).toEqual([
      "warning: the extensions in the shared pi folder were not checked (pi list exited with 2); pi installs what is missing when it starts",
    ]);
    expect(await garbled.install()).toEqual([
      "warning: the extensions in the shared pi folder were not checked (pi list printed nothing pinata understands); pi installs what is missing when it starts",
    ]);
    expect(await hung.install({ listTimeoutMs: 20 })).toEqual([
      "warning: the extensions in the shared pi folder were not checked (the command in the sandbox did not finish within 20 ms); pi installs what is missing when it starts",
    ]);
  });

  it("bounds both commands in the sandbox, so a stuck pi does not outlive the launch", () => {
    expect(LIST_COMMAND).toEqual(["timeout", "-k", "10", "60", "pi", "list"]);
    expect(INSTALL_COMMAND).toEqual(["timeout", "-k", "10", "600", "pi", "--help"]);
  });
});

describe("installPackages with a source that did not install", () => {
  const MISSING = [BOLD("User packages:"), "  git:github.com/owner/private@main", ""].join("\n");

  const MOVED = [BOLD("User packages:"), "  git:github.com/owner/private@v2", ""].join("\n");

  const LANDED = [
    BOLD("User packages:"),
    "  git:github.com/owner/private@main",
    DIM("    /home/pi/.pi/agent/git/github.com/owner/private"),
    "",
  ].join("\n");

  const SKIPPED =
    "warning: git:github.com/owner/private@main could not be installed in the shared pi folder last time, so pinata did not try again; pi tries when it starts";

  const packages = { sources: ["git:github.com/owner/private@main"], changed: [] };

  it("remembers it, and the next launch does not run pi for it but says so", async () => {
    const env = await setup([{ stdout: MISSING }, { code: 0 }, { stdout: MISSING }]);

    expect(await env.install({ packages })).toEqual([
      "warning: git:github.com/owner/private@main could not be installed in the shared pi folder; pi tries again when it starts",
    ]);

    const recorded = await readFile(env.failedPath, "utf8");

    expect(recorded).not.toContain("owner/private");

    env.answer({ stdout: MISSING });

    expect(await env.install({ packages })).toEqual([SKIPPED]);
    expect(env.commands()).toEqual([LIST_COMMAND, INSTALL_COMMAND, LIST_COMMAND, LIST_COMMAND]);
    expect(env.announced).toHaveLength(1);
  });

  it("remembers every missing source when pi itself fails or times out", async () => {
    const env = await setup([{ stdout: MISSING }, { code: 124 }, { stdout: MISSING }]);

    await env.install({ packages });

    expect(await env.install({ packages })).toEqual([SKIPPED]);
    expect(env.commands()).toEqual([LIST_COMMAND, INSTALL_COMMAND, LIST_COMMAND]);
  });

  it("tries again once the pinned source changed", async () => {
    const env = await setup([{ stdout: MISSING }, { code: 0 }, { stdout: MISSING }]);

    await env.install({ packages });

    env.answer({ stdout: MOVED }, { code: 0 }, { stdout: LANDED });

    expect(
      await env.install({ packages: { sources: ["git:github.com/owner/private@v2"], changed: [] } }),
    ).toEqual([]);
    expect(env.commands().slice(3)).toEqual([LIST_COMMAND, INSTALL_COMMAND, LIST_COMMAND]);
  });

  it("forgets it once pi installed it, so a later loss is tried again", async () => {
    const env = await setup([{ stdout: MISSING }, { code: 0 }, { stdout: MISSING }]);

    await env.install({ packages });

    env.answer({ stdout: LANDED }, { stdout: MISSING }, { code: 0 }, { stdout: LANDED });

    expect(await env.install({ packages })).toEqual([]);
    expect(await env.install({ packages })).toEqual([]);
    expect(env.commands().slice(3)).toEqual([LIST_COMMAND, LIST_COMMAND, INSTALL_COMMAND, LIST_COMMAND]);
  });

  it("still installs a moved npm pin while a remembered source stays skipped", async () => {
    const both = [
      BOLD("User packages:"),
      "  git:github.com/owner/private@main",
      "  npm:tool@1.1.0",
      DIM("    /n"),
      "",
    ].join("\n");
    const env = await setup([{ stdout: MISSING }, { code: 0 }, { stdout: MISSING }]);

    await env.install({ packages });

    env.answer({ stdout: both }, { code: 0 }, { stdout: both });

    expect(
      await env.install({
        packages: { sources: ["git:github.com/owner/private@main", "npm:tool@1.1.0"], changed: ["npm:tool"] },
      }),
    ).toEqual([SKIPPED]);
    expect(env.commands().slice(3)).toEqual([LIST_COMMAND, INSTALL_COMMAND, LIST_COMMAND]);
  });

  it("reads a broken record as none", async () => {
    const env = await setup([{ stdout: MISSING }, { code: 0 }, { stdout: LANDED }]);

    await writeFile(env.failedPath, "{ broken");

    expect(await env.install({ packages })).toEqual([]);
    expect(env.commands()).toEqual([LIST_COMMAND, INSTALL_COMMAND, LIST_COMMAND]);
  });
});
