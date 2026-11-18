import { mkdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addedRootProblem,
  folderCandidates,
  isPreChecked,
  replacedNotice,
  replacedRoots,
  sameRootSet,
  scanRepos,
  suggestionFor,
  tildeForm,
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
  it("lists configured roots, PI_SANDBOX_ROOTS, the cwd's top folder and usual folders, by repositories", async () => {
    const context = await homeWith(
      ["Projects/a", "Projects/b", "Projects/c/d", "Sites/s", "clients/acme/x"],
      ["src"],
    );
    const candidates = await folderCandidates({
      ...context,
      env: { ...context.env, PI_SANDBOX_ROOTS: "/Volumes/Env:~/later" },
      cwd: join(context.home, "clients", "acme"),
      configRoots: ["~/kept"],
      firstRun: true,
    });

    expect(
      candidates.map((candidate) => [candidate.stored, candidate.origin, candidate.repos, candidate.here]),
    ).toEqual([
      ["~/kept", "config", 0, false],
      ["/Volumes/Env", "env", 0, false],
      ["~/later", "env", 0, false],
      ["~/Projects", "usual", 3, false],
      ["~/clients", "cwd", 1, true],
      ["~/Sites", "usual", 1, false],
      ["~/src", "usual", 0, false],
    ]);
    expect(candidates[0]).toMatchObject({ exists: false, resolved: join(context.home, "kept") });
  });

  it("reads PI_SANDBOX_ROOTS only on a first run and pre-checks the right ones", async () => {
    const context = await homeWith(["work/a"], ["src"]);
    const rerun = await folderCandidates({
      ...context,
      env: { ...context.env, PI_SANDBOX_ROOTS: "/Volumes/Env" },
      cwd: "/",
      configRoots: ["~/work"],
      firstRun: false,
    });
    const first = await folderCandidates({ ...context, cwd: "/", configRoots: undefined, firstRun: true });

    expect(rerun.map((candidate) => candidate.stored)).toEqual(["~/work", "~/src"]);
    expect(first.map((candidate) => [candidate.stored, isPreChecked(candidate, true)])).toEqual([
      ["~/work", true],
      ["~/src", false],
    ]);
    expect(rerun.map((candidate) => isPreChecked(candidate, false))).toEqual([true, false]);
  });

  it("lists one folder once by its real path", async () => {
    const context = await homeWith(["Projects/a"]);

    await symlink(join(context.home, "Projects"), join(context.home, "code"));

    const candidates = await folderCandidates({
      ...context,
      cwd: "/",
      configRoots: ["~/Projects"],
      firstRun: true,
    });

    expect(candidates.map((candidate) => candidate.stored)).toEqual(["~/Projects"]);
  });

  it("skips a cwd folder the guard refuses", async () => {
    const context = await homeWith([], [".ssh/keys"]);
    const candidates = await folderCandidates({
      ...context,
      cwd: join(context.home, ".ssh", "keys"),
      configRoots: undefined,
      firstRun: true,
    });

    expect(candidates).toEqual([]);
  });
});

describe("unscannedCandidates", () => {
  it("resolves configured roots to their real paths and says which exist, as a full search does", async () => {
    const context = await homeWith([], ["Projects"]);

    await symlink(join(context.home, "Projects"), join(context.home, "code"));

    const search = { ...context, cwd: "/", configRoots: ["~/code", "~/gone"], firstRun: false };
    const shown = (candidates: { stored: string; resolved: string; exists: boolean }[]) =>
      candidates.map((candidate) => [candidate.stored, candidate.resolved, candidate.exists]);

    expect(shown(unscannedCandidates(search))).toEqual([
      ["~/code", join(context.home, "Projects"), true],
      ["~/gone", join(context.home, "gone"), false],
    ]);
    expect(shown(unscannedCandidates(search))).toEqual(shown(await folderCandidates(search)));
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

describe("addedRootProblem", () => {
  const setup = async () => {
    const context = await homeWith([], ["Projects/app", "work", "a,b", "tools/agent"]);

    await writeFile(join(context.home, "notes.txt"), "");

    return {
      ...context,
      env: { PI_CODING_AGENT_DIR: join(context.home, "tools", "agent") },
      checked: ["~/work"],
      listed: ["~/work"],
    };
  };

  it.each([
    ["", "Type the path of a folder."],
    ["~/", "Type the path of a folder."],
    ["work", "Type a full path, starting with / or ~/."],
    ["~/a\u0007", "That path has a control character in it."],
    ["~/Projcts", "~/Projcts does not exist. Did you mean ~/Projects?"],
    ["~/nothing-like-it", "~/nothing-like-it does not exist."],
    ["~/notes.txt", "~/notes.txt is a file, not a folder."],
    ["~", "~ is your whole home. Choose the folders inside it that hold projects."],
    [
      "~/tools/agent",
      "~/tools/agent cannot be shared: the sandbox must never see it, since it holds secrets or system files. Choose another folder.",
    ],
    ["/", "/ is your whole home. Choose the folders inside it that hold projects."],
    ["/etc/x", "/etc/x lies inside /etc, which the sandbox must never see."],
    [
      "~/tools",
      "~/tools holds pi's agent directory, which the sandbox must never see. Choose a folder inside it.",
    ],
    [
      "~/a,b",
      '~/a,b has a "," or ":" in its name, which the VM cannot share. Rename it or choose another folder.',
    ],
    ["~/work/", "~/work is already in the list."],
  ])("refuses %j", async (typed, message) => {
    const context = await setup();
    expect(addedRootProblem(typed, context)).toBe(message);
  });

  it("accepts a folder inside a checked one, refuses one holding a checked one, and accepts a plain one", async () => {
    const context = await setup();

    expect(
      addedRootProblem("~/Projects/app", { ...context, checked: ["~/Projects"], listed: ["~/Projects"] }),
    ).toBeUndefined();
    expect(
      addedRootProblem("~/Projects", { ...context, checked: ["~/Projects/app"], listed: ["~/Projects/app"] }),
    ).toBe(
      "~/Projects holds ~/Projects/app, which is selected. Unselect ~/Projects/app first, or choose another folder.",
    );
    expect(addedRootProblem("~/Projects", context)).toBeUndefined();
  });

  it("refuses typed text the VM cannot share even when it links to a clean folder", async () => {
    const context = await setup();

    await symlink(join(context.home, "Projects", "app"), join(context.home, "x:y"));

    await symlink(join(context.home, "Projects", "app"), join(context.home, "x\u0007"));

    expect(addedRootProblem("~/x:y", context)).toBe(
      '~/x:y has a "," or ":" in its name, which the VM cannot share. Rename it or choose another folder.',
    );
    expect(addedRootProblem("~/x\u0007", context)).toBe("That path has a control character in it.");
  });

  it("escapes control and bidi characters of the folders it names", async () => {
    const context = await setup();

    expect(addedRootProblem("~/gone\u202e", context)).toBe("~/gone\\u202E does not exist.");
    expect(
      addedRootProblem("~/Projects", { ...context, checked: ["~/Projects/app\u200f"], listed: [] }),
    ).toBe(
      "~/Projects holds ~/Projects/app\\u200F, which is selected. Unselect ~/Projects/app\\u200F first, or choose another folder.",
    );
  });

  it("names every checked folder that holds the typed one, through links too", async () => {
    const context = await setup();

    await symlink(join(context.home, "Projects"), join(context.home, "link"));

    const checked = ["~/Projects", "~/link", "~/work"];
    const listed = [...checked, "~/Projects/app"];

    expect(replacedRoots("~/Projects/app ", { ...context, checked, listed })).toEqual([
      "~/Projects",
      "~/link",
    ]);
    expect(replacedRoots("~/Projects", { ...context, checked: ["~/work"], listed: ["~/work"] })).toEqual([]);
    expect(replacedRoots("~/.ssh", { ...context, checked: ["~"], listed: [] })).toEqual([]);
    expect(addedRootProblem("~/Projects/app", { ...context, checked, listed })).toBe(
      "~/Projects/app is already in the list.",
    );
  });

  it("tells which checked folders the typed one replaces, escaping their names", () => {
    expect(replacedNotice("~/Projects/app", ["~/Projects"], "/home/me")).toBe(
      "~/Projects/app replaces ~/Projects, which holds it.",
    );
    expect(replacedNotice("/home/me/Projects/app\u202e", ["~/Projects\u009b/..", "~/link"], "/home/me")).toBe(
      "~/Projects/app\\u202E replaces ~/Projects\\u009B/.. and ~/link, which hold it.",
    );
    expect(replacedNotice("~/a/b/c", ["~/a", "~/link", "/Volumes/a"], "/home/me")).toBe(
      "~/a/b/c replaces ~/a, ~/link and /Volumes/a, which hold it.",
    );
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

describe("sameRootSet", () => {
  it("compares roots by the folders they share, whatever the spelling or order", async () => {
    const context = await homeWith([], ["a", "b"]);

    expect(sameRootSet(["~/a", "~/b/"], [join(context.home, "b"), "~/a"], context)).toBe(true);
    expect(sameRootSet(["~/a"], ["~/b"], context)).toBe(false);
  });
});
