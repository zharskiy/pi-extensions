import { mkdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  folderCandidates,
  sameRoot,
  scanRepos,
  suggestionFor,
  tildeForm,
  typedRootProblem,
  USUAL_FOLDERS,
  unscannedCandidates,
} from "../../cli/setup/folders.ts";
import { tempDir } from "../support/temp-dir.ts";

const homeWith = async (repos: string[], folders: string[] = []) => {
  const home = await realpath(await tempDir("setup-home"));

  await Promise.all(repos.map((repo) => mkdir(join(home, repo, ".git"), { recursive: true })));

  await Promise.all(folders.map((folder) => mkdir(join(home, folder), { recursive: true })));

  return { home, env: { PI_CODING_AGENT_DIR: join(home, ".pi", "agent") } };
};

describe("the usual project folders", () => {
  it("lists the names the design names, in its order", () => {
    expect(USUAL_FOLDERS).toEqual([
      "Projects",
      "projects",
      "Developer",
      "Code",
      "code",
      "src",
      "dev",
      "Dev",
      "work",
      "Work",
      "git",
      "GitHub",
      "github",
      "repos",
      "Repos",
      "workspace",
      "Workspace",
      "Sites",
    ]);
  });
});

describe("folderCandidates", () => {
  it("lists the configured root, PINATA_ROOT, the cwd's top folder and usual folders, by repositories", async () => {
    const context = await homeWith(
      ["Projects/a", "Projects/b", "Projects/c/d", "Sites/s", "clients/acme/x"],
      ["src"],
    );
    const candidates = await folderCandidates({
      ...context,
      env: { ...context.env, PINATA_ROOT: "/Volumes/Env" },
      cwd: join(context.home, "clients", "acme"),
      configRoot: "~/kept",
      firstRun: true,
    });

    expect(
      candidates.map((candidate) => [candidate.stored, candidate.origin, candidate.repos, candidate.here]),
    ).toEqual([
      ["~/kept", "config", 0, false],
      ["/Volumes/Env", "env", 0, false],
      ["~/Projects", "usual", 3, false],
      ["~/clients", "cwd", 1, true],
      ["~/Sites", "usual", 1, false],
      ["~/src", "usual", 0, false],
    ]);
    expect(candidates[0]).toMatchObject({ exists: false, resolved: join(context.home, "kept") });
  });

  it("reads PINATA_ROOT only on a first run", async () => {
    const context = await homeWith(["work/a"], ["src"]);
    const env = { ...context.env, PINATA_ROOT: "/Volumes/Env" };
    const rerun = await folderCandidates({
      ...context,
      env,
      cwd: "/",
      configRoot: "~/work",
      firstRun: false,
    });
    const first = await folderCandidates({
      ...context,
      env,
      cwd: "/",
      configRoot: undefined,
      firstRun: true,
    });

    expect(rerun.map((candidate) => candidate.stored)).toEqual(["~/work", "~/src"]);
    expect(first.map((candidate) => candidate.stored)).toEqual(["/Volumes/Env", "~/work", "~/src"]);
  });

  it("lists one folder once by its real path", async () => {
    const context = await homeWith(["Projects/a"]);

    await symlink(join(context.home, "Projects"), join(context.home, "code"));

    const candidates = await folderCandidates({
      ...context,
      cwd: "/",
      configRoot: "~/Projects",
      firstRun: true,
    });

    expect(candidates.map((candidate) => candidate.stored)).toEqual(["~/Projects"]);
  });

  it("skips a cwd folder the guard refuses", async () => {
    const context = await homeWith([], [".ssh/keys"]);
    const candidates = await folderCandidates({
      ...context,
      cwd: join(context.home, ".ssh", "keys"),
      configRoot: undefined,
      firstRun: true,
    });

    expect(candidates).toEqual([]);
  });
});

describe("unscannedCandidates", () => {
  it("resolves the configured root to its real path and says whether it exists, as a full search does", async () => {
    const context = await homeWith([], ["Projects"]);

    await symlink(join(context.home, "Projects"), join(context.home, "code"));

    const shown = (candidates: { stored: string; resolved: string; exists: boolean }[]) =>
      candidates.map((candidate) => [candidate.stored, candidate.resolved, candidate.exists]);
    const linked = { ...context, cwd: "/", configRoot: "~/code", firstRun: false };
    const gone = { ...context, cwd: "/", configRoot: "~/gone", firstRun: false };

    expect(shown(unscannedCandidates(linked))).toEqual([["~/code", join(context.home, "Projects"), true]]);
    expect(shown(unscannedCandidates(gone))).toEqual([["~/gone", join(context.home, "gone"), false]]);
    expect(shown(unscannedCandidates(linked))).toEqual(shown(await folderCandidates(linked)));
  });
});

describe("scanRepos", () => {
  it("counts repositories one and two levels down, without links, dot folders or node_modules", async () => {
    const { home } = await homeWith([
      "p/a",
      "p/group/b",
      "p/group/deep/c",
      "p/.hidden/d",
      "p/node_modules/e",
      "other/f",
    ]);

    await writeFile(join(home, "p", "worktree"), "");

    await mkdir(join(home, "p", "wt"), { recursive: true });

    await writeFile(join(home, "p", "wt", ".git"), "gitdir: /elsewhere\n");

    await symlink(join(home, "other"), join(home, "p", "linked"));

    expect(await scanRepos(join(home, "p"))).toMatchObject({ repos: 3, capped: false });
  });

  it("keeps the most recently changed repository", async () => {
    const { home } = await homeWith(["p/old", "p/new"]);

    await utimes(join(home, "p", "old", ".git"), 1000, 1000);

    await utimes(join(home, "p", "new", ".git"), 2000, 2000);

    expect((await scanRepos(join(home, "p"))).latestRepo).toBe(join(home, "p", "new"));
  });

  it("stops at the repository, entry and time caps", async () => {
    const { home } = await homeWith(["p/a", "p/b", "p/c", "p/d"]);
    const clock = { now: 0 };
    const ticking = () => {
      clock.now += 100;

      return clock.now;
    };

    expect(await scanRepos(join(home, "p"), { maxRepos: 2 })).toMatchObject({ repos: 2, capped: true });
    expect(await scanRepos(join(home, "p"), { maxEntries: 1 })).toMatchObject({ capped: true });
    expect(await scanRepos(join(home, "p"), { now: ticking, budgetMs: 150 })).toMatchObject({
      repos: 1,
      capped: true,
    });
  });
});

describe("tildeForm", () => {
  it("stores a path under the home as ~/ and others as typed, without a trailing slash", () => {
    expect(tildeForm("/Users/me/work/", "/Users/me")).toBe("~/work");
    expect(tildeForm("~/work/", "/Users/me")).toBe("~/work");
    expect(tildeForm("/Volumes/Code/", "/Users/me")).toBe("/Volumes/Code");
    expect(tildeForm("/Users/me", "/Users/me")).toBe("~");
  });
});

describe("typedRootProblem", () => {
  const setup = async () => {
    const context = await homeWith([], ["Projects/app", "work", "a,b", "tools/agent"]);

    await writeFile(join(context.home, "notes.txt"), "");

    return { home: context.home, env: { PI_CODING_AGENT_DIR: join(context.home, "tools", "agent") } };
  };

  const HOME =
    "is your home or holds it, and the sandbox VM must not see all of it. Choose the folder in it that holds your projects.";

  it.each([
    ["", "Type the path of a folder."],
    ["~/", "Type the path of a folder."],
    ["work", "Type a full path, starting with / or ~/."],
    ["~/a\u0007", "That path has a control character in it."],
    ["~/Projcts", "~/Projcts does not exist. Did you mean ~/Projects?"],
    ["~/nothing-like-it", "~/nothing-like-it does not exist."],
    ["~/notes.txt", "~/notes.txt is a file, not a folder."],
    ["~", `~ ${HOME}`],
    [
      "~/tools/agent",
      "~/tools/agent cannot be shared: the sandbox must never see it, since it holds secrets or system files. Choose another folder.",
    ],
    ["/", `/ ${HOME}`],
    ["/etc/x", "/etc/x lies inside /etc, which the sandbox must never see."],
    [
      "~/tools",
      "~/tools holds pi's agent directory, which the sandbox must never see. Choose a folder inside it.",
    ],
    [
      "~/a,b",
      '~/a,b has a "," or ":" in its name, which the VM cannot share. Rename it or choose another folder.',
    ],
  ])("refuses %j", async (typed, message) => {
    const context = await setup();

    expect(typedRootProblem(typed, context)).toBe(message);
  });

  it("refuses the folder that holds the home", async () => {
    const context = await setup();
    const parent = dirname(context.home);

    expect(typedRootProblem(parent, context)).toBe(`${parent} ${HOME}`);
  });

  it("accepts a folder, one inside another, and one typed with a trailing slash", async () => {
    const context = await setup();

    expect(typedRootProblem("~/Projects", context)).toBeUndefined();
    expect(typedRootProblem("~/Projects/app", context)).toBeUndefined();
    expect(typedRootProblem(" ~/work/ ", context)).toBeUndefined();
  });

  it("refuses typed text the VM cannot share even when it links to a clean folder", async () => {
    const context = await setup();

    await symlink(join(context.home, "Projects", "app"), join(context.home, "x:y"));

    await symlink(join(context.home, "Projects", "app"), join(context.home, "x\u0007"));

    expect(typedRootProblem("~/x:y", context)).toBe(
      '~/x:y has a "," or ":" in its name, which the VM cannot share. Rename it or choose another folder.',
    );
    expect(typedRootProblem("~/x\u0007", context)).toBe("That path has a control character in it.");
  });

  it("escapes control and bidi characters of the folders it names", async () => {
    const context = await setup();

    expect(typedRootProblem("~/gone\u202e", context)).toBe("~/gone\\u202E does not exist.");
  });

  it("suggests a sibling folder that differs in case or by at most two letters", async () => {
    const context = await homeWith([], ["Projects", "Pictures", "a", ".ssh", "Library"]);
    const suggested = (name: string) => suggestionFor(join(context.home, name), { ...context, env: {} });

    expect(suggested("Projets")).toBe(join(context.home, "Projects"));
    expect(suggested("projects")).toBe(join(context.home, "Projects"));
    expect(suggested("zzz")).toBeUndefined();
  });

  it("never suggests a protected folder or an unrelated short name", async () => {
    const context = await homeWith([], ["a", ".ssh", "Library"]);
    const suggested = (name: string) => suggestionFor(join(context.home, name), { ...context, env: {} });

    expect(suggested(".sshh")).toBeUndefined();
    expect(suggested("Librar")).toBeUndefined();
    expect(suggested("c")).toBeUndefined();
  });
});

describe("sameRoot", () => {
  it("compares roots by the folder they share, whatever the spelling", async () => {
    const context = await homeWith([], ["a", "b"]);

    await symlink(join(context.home, "a"), join(context.home, "link"));

    expect(sameRoot("~/b/", join(context.home, "b"), context)).toBe(true);
    expect(sameRoot("~/a", "~/link", context)).toBe(true);
    expect(sameRoot("~/a", "~/b", context)).toBe(false);
  });
});
