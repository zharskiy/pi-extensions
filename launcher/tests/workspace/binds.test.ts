import { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confirmBinds, hostBinds } from "../../workspace/index.ts";
import { tempDir } from "../support/temp-dir.ts";

const createHome = async () => {
  const base = await realpath(await tempDir("binds"));
  const home = join(base, "home");
  const env = {
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    PI_SANDBOX_STATE_DIR: join(base, "state"),
    PI_SANDBOX_USER_CONFIG: join(base, "config", "config.json"),
  };

  await Promise.all(
    [
      join(base, "data", "ref"),
      join(base, "work", "repo", "src"),
      join(home, "tools"),
      join(home, ".ssh"),
      env.PI_SANDBOX_STATE_DIR,
    ].map((dir) => mkdir(dir, { recursive: true })),
  );

  await writeFile(join(home, "tools", "tool.conf"), "x");

  return { base, home, context: { home, env, roots: [join(base, "work", "repo")] } };
};

describe("hostBinds", () => {
  it("resolves ~ and links, and shares a folder itself and a file through its folder", async () => {
    const { base, home, context } = await createHome();

    await symlink(join(base, "data", "ref"), join(base, "link"));

    expect(
      hostBinds(
        [
          { source: join(base, "link"), target: "/srv/ref" },
          { source: "~/tools/tool.conf", target: "/etc/tool.conf" },
        ],
        context,
      ),
    ).toEqual([
      {
        key: "mounts.binds[0].source",
        source: join(base, "data", "ref"),
        target: "/srv/ref",
        share: join(base, "data", "ref"),
        directory: true,
      },
      {
        key: "mounts.binds[1].source",
        source: join(home, "tools", "tool.conf"),
        target: "/etc/tool.conf",
        share: join(home, "tools"),
        directory: false,
      },
    ]);
  });

  it("refuses a source that does not exist, naming the key", async () => {
    const { base, context } = await createHome();

    expect(() => hostBinds([{ source: join(base, "missing"), target: "/srv/x" }], context)).toThrow(
      `config: mounts.binds[0].source: ${join(base, "missing")} does not exist`,
    );
  });

  it("refuses the home itself, a protected folder and a file directly in the home", async () => {
    const { home, context } = await createHome();

    await writeFile(join(home, "notes.txt"), "x");

    expect(() => hostBinds([{ source: "~", target: "/srv/x" }], context)).toThrow("mounts.binds[0].source");
    expect(() => hostBinds([{ source: "~/.ssh", target: "/srv/x" }], context)).toThrow(
      "mounts.binds[0].source",
    );
    expect(() => hostBinds([{ source: "~/notes.txt", target: "/srv/x" }], context)).toThrow(
      "mounts.binds[0].source",
    );
  });

  it("refuses the launcher state dir", async () => {
    const { context } = await createHome();

    expect(() =>
      hostBinds([{ source: context.env.PI_SANDBOX_STATE_DIR, target: "/srv/x" }], context),
    ).toThrow("mounts.binds[0].source");
  });

  it("refuses a source inside the repo, one that holds it, and a link into it, naming the entry", async () => {
    const { base, context } = await createHome();
    const repo = join(base, "work", "repo");

    await symlink(join(repo, "src"), join(base, "into-repo"));

    expect(() => hostBinds([{ source: join(repo, "src"), target: "/srv/x" }], context)).toThrow(
      `config: mounts.binds[0].source: ${join(repo, "src")} overlaps ${repo}`,
    );
    expect(() => hostBinds([{ source: join(base, "work"), target: "/srv/x" }], context)).toThrow(
      `config: mounts.binds[0].source: ${join(base, "work")} overlaps ${repo}`,
    );
    expect(() =>
      hostBinds(
        [
          { source: join(base, "data", "ref"), target: "/srv/ref" },
          { source: join(base, "into-repo"), target: "/srv/x" },
        ],
        context,
      ),
    ).toThrow("config: mounts.binds[1].source");
  });

  it("compares a workspace root by its real path", async () => {
    const { base, context } = await createHome();

    await symlink(join(base, "data"), join(base, "data-link"));

    expect(() =>
      hostBinds([{ source: join(base, "data", "ref"), target: "/srv/x" }], {
        ...context,
        roots: [join(base, "data-link")],
      }),
    ).toThrow(`overlaps ${join(base, "data")}`);
  });
});

describe("confirmBinds", () => {
  it("passes binds that still are what they were", async () => {
    const { base, context } = await createHome();
    const binds = hostBinds([{ source: join(base, "data", "ref"), target: "/srv/ref" }], context);

    expect(() => confirmBinds(binds)).not.toThrow();
  });

  it("refuses a source swapped for a link, a file or nothing since it was resolved", async () => {
    const { base, context } = await createHome();
    const source = join(base, "data", "ref");
    const binds = hostBinds([{ source, target: "/srv/ref" }], context);
    const swapped = `config: mounts.binds[0].source: ${source} changed while pi was starting, refusing`;

    await rename(source, join(base, "data", "moved"));

    await symlink(join(base, "work", "repo"), source);

    expect(() => confirmBinds(binds)).toThrow(swapped);

    await rm(source);

    await writeFile(source, "x");

    expect(() => confirmBinds(binds)).toThrow(swapped);

    await rm(source);

    expect(() => confirmBinds(binds)).toThrow(swapped);
  });

  it("refuses a source whose parent was swapped for a link", async () => {
    const { base, context } = await createHome();
    const binds = hostBinds([{ source: join(base, "data", "ref"), target: "/srv/ref" }], context);

    await rename(join(base, "data"), join(base, "elsewhere"));

    await mkdir(join(base, "work", "repo", "ref"));

    await symlink(join(base, "work", "repo"), join(base, "data"));

    expect(() => confirmBinds(binds)).toThrow("mounts.binds[0].source");
  });
});
