import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";

const entrypoint = () => readFile(join(launcherRoot(), "image", "entrypoint.sh"), "utf8");

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const sandboxRoot = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-sandbox-entrypoint-")));

  created.push(root);
  const paths = {
    root,
    home: join(root, "home"),
    render: join(root, "opt", "render"),
    bundle: join(root, "tmp"),
    system: join(root, "system.crt"),
    trust: join(root, "etc", "ca.pem"),
  };

  await mkdir(paths.render, { recursive: true });

  await mkdir(join(paths.root, "etc"), { recursive: true });

  await writeFile(paths.system, "SYSTEM\n");

  return paths;
};

type Paths = Awaited<ReturnType<typeof sandboxRoot>>;

const runEntrypoint = async (paths: Paths) => {
  const guestPaths: Record<string, string> = {
    "/opt/pi-sandbox/render": paths.render,
    "/tmp/pi-sandbox": paths.bundle,
    "/etc/ssl/certs/ca-certificates.crt": paths.system,
    "/etc/pi-sandbox/ca.pem": paths.trust,
  };
  const guestPath = new RegExp(
    Object.keys(guestPaths)
      .map((path) => path.replaceAll(".", "\\."))
      .join("|"),
    "g",
  );
  const script = (await entrypoint()).replace(guestPath, (path) => guestPaths[path] ?? path);
  const result = spawnSync("sh", ["-c", script, "entrypoint", "true"], {
    env: { PATH: process.env.PATH, HOME: paths.home },
    encoding: "utf8",
  });

  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
};

describe("image entrypoint", () => {
  it("links every rendered entry, replacing a file or dir an agent put in place of a link", async () => {
    const paths = await sandboxRoot();
    const agent = join(paths.home, ".pi", "agent");

    await writeFile(join(paths.render, "auth.json"), '{"rendered":true}\n');

    await mkdir(join(paths.render, "skills"));

    await mkdir(join(agent, "skills", "planted"), { recursive: true });

    await writeFile(join(agent, "auth.json"), '{"planted":true}\n');

    await runEntrypoint(paths);

    expect(await readlink(join(agent, "auth.json"))).toBe(join(paths.render, "auth.json"));
    expect(await readlink(join(agent, "skills"))).toBe(join(paths.render, "skills"));
  });

  it("drops dangling links into the render dir", async () => {
    const paths = await sandboxRoot();
    const agent = join(paths.home, ".pi", "agent");

    await mkdir(agent, { recursive: true });

    await writeFile(join(paths.render, "models.json"), "{}\n");

    await runEntrypoint(paths);

    await rm(join(paths.render, "models.json"));

    await runEntrypoint(paths);

    await expect(lstat(join(agent, "models.json"))).rejects.toThrow();
  });

  it("appends the mounted trust bundle to the CA bundle", async () => {
    const paths = await sandboxRoot();

    await writeFile(paths.trust, "TRUST\n");

    await runEntrypoint(paths);

    expect(await readFile(join(paths.bundle, "ca-bundle.pem"), "utf8")).toBe("SYSTEM\nTRUST\n");
  });
});
