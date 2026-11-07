import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherRoot } from "../../shared/index.ts";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const FAKE_CONTAINER = `#!/bin/sh
case "$1" in
  system) exit 0 ;;
  list) printf 'pi-sandbox-mine\\npi-sandbox-foreign\\nother\\n' ;;
  inspect)
    if [ "$2" = pi-sandbox-mine ]; then
      printf '[{"configuration":{"labels":{"pi-sandbox.managed": "true"}}}]\\n'
    else
      printf '[{"configuration":{"labels":{"owner":"someone"}}}]\\n'
    fi ;;
  delete) echo "$@" >> "$FAKE_LOG" ;;
  network)
    case "$2" in
      list) printf 'pi-sandbox\npi-sandbox-0123456789ab\npi-sandbox-other\nbridge\n' ;;
      inspect)
        if [ "$3" = pi-sandbox-other ]; then
          printf '[{"config":{"labels":{}}}]\n'
        else
          printf '[{"config":{"labels":{"pi-sandbox.managed":"true"}}}]\n'
        fi ;;
      delete) echo "$@" >> "$FAKE_LOG" ;;
    esac ;;
esac
`;

const FAKE_DOCKER = `#!/bin/sh
shift 2
case "$1 $2" in
  "network ls") echo "$@" >> "$FAKE_LOG.args"; printf 'net-legacy\\nnet-repo\\n' ;;
  "network rm") echo "$@" >> "$FAKE_LOG" ;;
esac
exit 0
`;

describe("uninstall.sh on the docker engine", () => {
  it("removes the legacy and per-repository networks the launcher labelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-uninstall-"));
    const bin = join(root, "bin");
    const log = join(root, "removed.log");

    created.push(root);

    await mkdir(bin, { recursive: true });

    await writeFile(join(bin, "docker"), FAKE_DOCKER);

    await chmod(join(bin, "docker"), 0o755);

    const result = spawnSync(
      "sh",
      [join(launcherRoot(), "uninstall.sh"), "--bin-dir", join(root, "local-bin")],
      {
        env: {
          HOME: join(root, "home"),
          PATH: `${bin}:/usr/bin:/bin`,
          PI_SANDBOX_STATE_DIR: join(root, "state"),
          FAKE_LOG: log,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("and 2 pi-sandbox networks");
    expect((await readFile(`${log}.args`, "utf8")).trim()).toBe(
      "network ls -q --filter label=pi-sandbox.managed=true --filter name=pi-sandbox",
    );
    expect((await readFile(log, "utf8")).trim()).toBe("network rm net-legacy net-repo");
  });
});

describe("uninstall.sh on the Apple runtime", () => {
  it("deletes only containers and networks that carry the launcher's managed label", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sandbox-uninstall-"));
    const bin = join(root, "bin");
    const log = join(root, "deleted.log");

    created.push(root);

    await mkdir(bin, { recursive: true });

    await writeFile(join(bin, "container"), FAKE_CONTAINER);

    await chmod(join(bin, "container"), 0o755);

    const result = spawnSync(
      "sh",
      [join(launcherRoot(), "uninstall.sh"), "--bin-dir", join(root, "local-bin")],
      {
        env: {
          HOME: join(root, "home"),
          PATH: `${bin}:/usr/bin:/bin`,
          PI_SANDBOX_STATE_DIR: join(root, "state"),
          FAKE_LOG: log,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "apple container: removed 1 pi-sandbox containers and 2 pi-sandbox networks",
    );
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "delete --force pi-sandbox-mine",
      "network delete pi-sandbox pi-sandbox-0123456789ab",
    ]);
  });
});
