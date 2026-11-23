import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installIdOf, type MountSpec } from "../../backend/index.ts";
import {
  buildContainerSpec,
  forwardedEnv,
  forwardedNames,
  mountedVolumes,
  overlayVolumes,
  volumePlan,
} from "../../container/index.ts";
import type { ContainerSpecInput } from "../../container/spec.ts";
import { isLauncherSetVariable, sha256Hex } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const repoRoot = "/work/repo";

const repoHash = sha256Hex(repoRoot);

const proxy = {
  url: "http://pi-sandbox-proxy:3128",
  network: { kind: "internal" as const, name: "pi-sandbox" },
};

const launchId = "0123456789abcdef";

const specInput = (overrides: Partial<ContainerSpecInput> = {}): ContainerSpecInput => ({
  workspace: { cwd: "/work/repo/src", repoRoot, gitCommonDir: "/work/repo/.git", isGitRepo: true },
  config: sandboxConfig(),
  image: { digest: "sha256:abc", id: "sha256:image-abc" },
  stateDir: "/state",
  launchId,
  proxy,
  workspaceRoot: "/work",
  servicePorts: [],
  renderDir: "/state/render",
  hostSessions: { off: "sessions.host is off", notice: false },
  toolEnv: {},
  binds: [],
  ...overrides,
});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-spec-")));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const mountAt = (mounts: MountSpec[], target: string) => mounts.find((mount) => mount.target === target);

describe("buildContainerSpec", () => {
  it("names the container after the repo hash and the launch", () => {
    expect(buildContainerSpec(specInput()).name).toBe(`pi-sandbox-${repoHash.slice(0, 12)}-${launchId}`);
  });

  it("labels the container with its repo, its launch and its image", () => {
    expect(buildContainerSpec(specInput()).labels).toEqual({
      "pi-sandbox.role": "agent",
      "pi-sandbox.repo-hash": repoHash,
      "pi-sandbox.repo-root": repoRoot,
      "pi-sandbox.launch-id": launchId,
      "pi-sandbox.image-digest": "sha256:abc",
      "pi-sandbox.session-dir": "sessions.host is off",
    });
  });

  it("creates the container from the image id", () => {
    expect(buildContainerSpec(specInput()).image).toBe("sha256:image-abc");
  });

  it("binds the workspace root read-write at its own path and nothing narrower", () => {
    const binds = buildContainerSpec(specInput()).mounts.filter((mount) => mount.kind === "bind");

    expect(binds.filter((mount) => !mount.readOnly)).toEqual([
      { source: "/work", target: "/work", readOnly: false, kind: "bind" },
    ]);
    expect(binds.filter((mount) => mount.target.startsWith("/work/"))).toEqual([]);
  });

  it("binds only the workspace root for a linked worktree whose common dir lies elsewhere in it", () => {
    const workspace = {
      cwd: "/work/wt",
      repoRoot: "/work/wt",
      gitDir: "/work/main/.git/worktrees/wt",
      gitCommonDir: "/work/main/.git",
      isGitRepo: true,
    };
    const binds = buildContainerSpec(specInput({ workspace })).mounts.filter(
      (mount) => mount.kind === "bind",
    );

    expect(binds.filter((mount) => mount.target.startsWith("/work"))).toEqual([
      { source: "/work", target: "/work", readOnly: false, kind: "bind" },
    ]);
  });

  it("needs no git mounts outside git", () => {
    const workspace = { cwd: "/work/plain", repoRoot: "/work/plain", isGitRepo: false };
    const spec = buildContainerSpec(specInput({ workspace }));

    expect(spec.mounts.filter((mount) => mount.target.includes(".git"))).toEqual([]);
  });

  it("keeps pi's agent dir on one named volume per install, the same for every repository, whatever USER says", () => {
    const agentVolume = `pi-sandbox-agent-${installIdOf("/state")}`;
    const other = { cwd: "/work/other", repoRoot: "/work/other", isGitRepo: false };

    expect(mountAt(buildContainerSpec(specInput()).mounts, "/home/pi/.pi/agent")).toEqual({
      source: agentVolume,
      target: "/home/pi/.pi/agent",
      readOnly: false,
      kind: "volume",
    });
    expect(
      mountAt(buildContainerSpec(specInput({ workspace: other })).mounts, "/home/pi/.pi/agent")?.source,
    ).toBe(agentVolume);
  });

  it("labels the agent volume with no repository, so the sweep and a folder's reset never take it", () => {
    const other = { cwd: "/work/other", repoRoot: "/work/other", isGitRepo: false };
    const agentOf = (workspace: typeof other) =>
      volumePlan({ workspace, config: sandboxConfig(), stateDir: "/state" }).find(
        (volume) => volume.key === "agent",
      );

    expect(agentOf({ cwd: repoRoot, repoRoot, isGitRepo: true })).toEqual(agentOf(other));
    expect(agentOf(other)?.labels).toEqual({});
  });

  it("lists the repository's agent and overlay volumes", () => {
    const config = sandboxConfig();
    const input = specInput({
      config,
      workspace: { cwd: repoRoot, repoRoot, isGitRepo: true, overlays: ["/work/repo/node_modules"] },
    });
    const volumes = buildContainerSpec(input)
      .mounts.filter((mount) => mount.kind === "volume")
      .map((mount) => mount.source);

    expect(
      volumePlan({ workspace: input.workspace, config, stateDir: "/state" }).map((volume) => volume.name),
    ).toEqual(volumes);
  });

  it("overlays the build output of every marker folder with a volume", () => {
    const workspace = {
      cwd: repoRoot,
      repoRoot,
      gitCommonDir: "/work/repo/.git",
      isGitRepo: true,
      overlays: ["/work/repo/node_modules", "/work/repo/api/.venv"],
    };
    const config = sandboxConfig();
    const input = specInput({ workspace, config });
    const mounts = buildContainerSpec(input).mounts;

    expect(overlayVolumes(workspace, config, "/state")).toEqual([
      {
        path: "/work/repo/node_modules",
        name: `pi-sandbox-cache-${installIdOf("/state")}-${repoHash.slice(0, 12)}-${sha256Hex("node_modules").slice(0, 8)}`,
      },
      {
        path: "/work/repo/api/.venv",
        name: `pi-sandbox-cache-${installIdOf("/state")}-${repoHash.slice(0, 12)}-${sha256Hex("api/.venv").slice(0, 8)}`,
      },
    ]);
    expect(mountAt(mounts, "/work/repo/api/.venv")).toMatchObject({ kind: "volume", readOnly: false });
    expect(volumePlan({ workspace, config, stateDir: "/state" }).map((volume) => volume.name)).toEqual(
      mounts.filter((mount) => mount.kind === "volume").map((mount) => mount.source),
    );
  });

  it("names no overlay volume when overlays are off", () => {
    const workspace = {
      cwd: repoRoot,
      repoRoot,
      isGitRepo: false,
      overlays: ["/work/repo/web/node_modules"],
    };

    expect(overlayVolumes(workspace, sandboxConfig({ mounts: { autoOverlays: false } }), "/state")).toEqual(
      [],
    );
  });

  it("refuses a bind target inside the workspace root before the engine could make its mount point there", () => {
    const binds = [{ source: "/Users/dev/reference", target: "/work/repo/reference" }];

    expect(() => buildContainerSpec(specInput({ binds }))).toThrow(
      "mounts: the sandbox would mount /work/repo/reference and /work inside one another, refusing",
    );
    expect(() =>
      buildContainerSpec(
        specInput({ binds: [{ source: "/Users/dev/reference", target: "/etc/reference" }] }),
      ),
    ).not.toThrow();
  });

  it("refuses a folder whose mount would cover a path the sandbox image needs", () => {
    const at = (repoRoot: string) => () =>
      buildContainerSpec(
        specInput({ workspace: { cwd: repoRoot, repoRoot, isGitRepo: false }, workspaceRoot: repoRoot }),
      );

    expect(at("/usr/local")).toThrow(
      "workspace: the sandbox would mount /usr/local over /usr, which the sandbox image needs, refusing",
    );
    expect(at("/usr/bin")).toThrow("over /usr");
    expect(at("/root/repo")).toThrow("over /root");
    expect(at("/etc")).toThrow("over /etc/ssl");
    expect(at("/opt")).toThrow("over /opt/pi-sandbox");
    expect(at("/etc/ssl")).toThrow("over /etc/ssl");
    expect(at("/usr/local/share")).toThrow("over /usr");
    expect(at("/home")).toThrow("over /home/pi");
    expect(at("/tmp")).toThrow("over /tmp");
    expect(at("/tmp/pi-sandbox-handover")).toThrow("over /tmp/pi-sandbox-handover");
    expect(at("/tmp/pi-sandbox-ready/repo")).toThrow("over /tmp/pi-sandbox-ready");
    expect(at("/tmp/pi-sandbox-repo")).not.toThrow();
    expect(at("/etc/pi-sandbox")).not.toThrow();
    expect(at("/tmp-work/repo")).not.toThrow();
    expect(at("/usr/local/src/app")).toThrow("over /usr");
    expect(at("/usrx/app")).not.toThrow();
  });

  it("mounts a workspace in the usual host folders", () => {
    const at = (repoRoot: string) => () =>
      buildContainerSpec(
        specInput({ workspace: { cwd: repoRoot, repoRoot, isGitRepo: false }, workspaceRoot: repoRoot }),
      );

    expect(at("/Users/dev/src/app")).not.toThrow();
    expect(at("/Volumes/Projects/app")).not.toThrow();
    expect(at("/home/dev/app")).not.toThrow();
    expect(at("/opt/src/app")).not.toThrow();
    expect(at("/srv/app")).not.toThrow();
    expect(at("/var/lib/app")).not.toThrow();
    expect(at("/private/var/folders/x/app")).not.toThrow();
  });

  it("mounts a user volume at its home path under one name for every repository of the same state dir", () => {
    const config = sandboxConfig({ mounts: { volumes: ["~/.cache/pip"] } });
    const other = { cwd: "/work/other", repoRoot: "/work/other", isGitRepo: false };
    const name = `pi-sandbox-shared-${installIdOf("/state")}-${sha256Hex("~/.cache/pip").slice(0, 8)}`;
    const first = buildContainerSpec(specInput({ config }));
    const second = buildContainerSpec(specInput({ config, workspace: other }));

    expect(mountedVolumes(config, "/state")).toEqual([
      { identity: "~/.cache/pip", target: "/home/pi/.cache/pip", name },
    ]);
    expect(mountAt(first.mounts, "/home/pi/.cache/pip")).toEqual({
      source: name,
      target: "/home/pi/.cache/pip",
      readOnly: false,
      kind: "volume",
    });
    expect(mountAt(second.mounts, "/home/pi/.cache/pip")?.source).toBe(name);
    expect(mountedVolumes(config, "/other-state")[0]?.name).not.toBe(name);
  });

  it("mounts the render dir read-only at the guest render path", () => {
    expect(
      mountAt(
        buildContainerSpec(specInput({ renderDir: "/state/render/abc" })).mounts,
        "/opt/pi-sandbox/render",
      ),
    ).toEqual({
      source: "/state/render/abc",
      target: "/opt/pi-sandbox/render",
      readOnly: true,
      kind: "bind",
    });
  });

  it("mounts no trust bundle and points Node at the system store the layer fills", () => {
    const spec = buildContainerSpec(specInput());

    expect(
      spec.mounts.some((mount) => mount.target.startsWith("/etc/ssl") || mount.source.includes("trust")),
    ).toBe(false);
    expect(spec.env.NODE_EXTRA_CA_CERTS).toBe("/etc/ssl/certs/ca-certificates.crt");
    expect(spec.env).not.toHaveProperty("PI_SANDBOX_TRUST_HASH");
  });

  it("names the proxy by its network alias, so a relay recreated for a new proxy port keeps working", () => {
    const spec = buildContainerSpec(specInput());

    expect(new URL(spec.env.HTTPS_PROXY ?? "").hostname).toBe("pi-sandbox-proxy");
    expect(spec.env.HTTP_PROXY).toBe(spec.env.HTTPS_PROXY);
    expect(spec.env.ALL_PROXY).toBe(spec.env.HTTPS_PROXY);
  });

  it("points every client at the proxy alias, with no token, and reaches the alias itself directly", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.env.HTTPS_PROXY).toBe("http://pi-sandbox-proxy:3128");
    expect(spec.env.https_proxy).toBe(spec.env.HTTPS_PROXY);
    expect(spec.env.no_proxy).toBe("localhost,127.0.0.1,::1,pi-sandbox-proxy");
    expect(spec.env.NO_PROXY).toBe("localhost,127.0.0.1,::1,pi-sandbox-proxy");
    expect(spec.env.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(spec.env.PIP_CERT).toBe("/etc/ssl/certs/ca-certificates.crt");
  });

  it("marks the sandbox and never sets pi offline", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.env.PI_SANDBOX).toBe("1");
    expect(spec.env.PI_OFFLINE).toBeUndefined();
  });

  it("runs with a read-only root, tmpfs for /tmp and home, and an init process", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.readOnlyRoot).toBe(true);
    expect(spec.tmpfs.map((entry) => entry.split(":")[0])).toEqual(["/tmp", "/home/pi"]);
    expect(spec.init).toBe(true);
  });

  it("lets programs run from /tmp and the home, which Docker mounts noexec by default", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.tmpfs).toEqual(["/tmp:mode=1777,exec", "/home/pi:mode=1777,exec"]);
  });

  it("joins the proxy route's network", () => {
    expect(buildContainerSpec(specInput()).network).toEqual({ kind: "internal", name: "pi-sandbox" });
  });

  it("holds only the proxy and static sandbox settings, no forwarded terminal variables", () => {
    expect(buildContainerSpec(specInput()).env).toEqual({
      HTTPS_PROXY: "http://pi-sandbox-proxy:3128",
      HTTP_PROXY: "http://pi-sandbox-proxy:3128",
      ALL_PROXY: "http://pi-sandbox-proxy:3128",
      NO_PROXY: "localhost,127.0.0.1,::1,pi-sandbox-proxy",
      https_proxy: "http://pi-sandbox-proxy:3128",
      http_proxy: "http://pi-sandbox-proxy:3128",
      all_proxy: "http://pi-sandbox-proxy:3128",
      no_proxy: "localhost,127.0.0.1,::1,pi-sandbox-proxy",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      CURL_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
      REQUESTS_CA_BUNDLE: "/etc/ssl/certs/ca-certificates.crt",
      PIP_CERT: "/etc/ssl/certs/ca-certificates.crt",
      CARGO_HTTP_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
      GIT_SSL_CAINFO: "/etc/ssl/certs/ca-certificates.crt",
      GIT_TERMINAL_PROMPT: "0",
      PI_SANDBOX: "1",
      PI_SANDBOX_STATUS: "/opt/pi-sandbox/render/tools/status.json",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_CLIPBOARD_OSC52: "1",
    });
  });

  it("never forwards a variable the sandbox sets, whatever the allowlist says", () => {
    const hostEnv = {
      HTTPS_PROXY: "http://dev:hunter2@proxy.corp.example:8080",
      https_proxy: "http://dev:hunter2@proxy.corp.example:8080",
      Http_Proxy: "http://dev:hunter2@proxy.corp.example:8080",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      HOME: "/Users/dev",
      PATH: "/opt/homebrew/bin",
      PWD: "/Users/dev/repo",
      PI_SANDBOX: "0",
      EDITOR: "vi",
    };

    expect(forwardedEnv(Object.keys(hostEnv), hostEnv)).toEqual({ EDITOR: "vi" });
  });

  it("names every variable it sets as launcher-set, so none can be forwarded over it", () => {
    const spec = buildContainerSpec(
      specInput({
        hostSessions: { dir: "/Users/dev/.pi/agent/sessions/--work-repo--" },
        toolEnv: { GITLAB_TOKEN: "pi-sandbox-gl", GITLAB_HOST: "gitlab.com" },
      }),
    );
    const names = Object.keys(spec.env);

    expect(names).toEqual(
      expect.arrayContaining(["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS", "PI_CODING_AGENT_SESSION_DIR"]),
    );
    expect(names.filter((name) => !isLauncherSetVariable(name))).toEqual([]);
    expect(forwardedEnv(names, spec.env)).toEqual({});
  });

  it("keeps a credential-bearing value on the host and names the variable", () => {
    const notices: string[] = [];
    const hostEnv = {
      PIP_INDEX_URL: "https://dev:hunter2@pypi.corp.example/simple",
      AUTH_HEADER: "Bearer abc.def",
      PLAIN_URL: "https://pypi.corp.example/simple",
      EDITOR: "vi",
    };

    expect(forwardedEnv(Object.keys(hostEnv), hostEnv, (notice) => notices.push(notice))).toEqual({
      PLAIN_URL: "https://pypi.corp.example/simple",
      EDITOR: "vi",
    });
    expect(notices).toEqual([
      "env.allow: PIP_INDEX_URL holds a credential, so it stays on the host",
      "env.allow: AUTH_HEADER holds a credential, so it stays on the host",
    ]);
  });

  it("sets the env.set values in the container next to the launcher's own variables", () => {
    const config = sandboxConfig({
      env: { allow: ["TERM"], set: { CI: "1", CHROME_PATH: "/usr/bin/chromium" } },
    });
    const env = buildContainerSpec(specInput({ config })).env;

    expect(env).toMatchObject({ CI: "1", CHROME_PATH: "/usr/bin/chromium", PI_SANDBOX: "1" });
    expect(env).toEqual(expect.objectContaining(buildContainerSpec(specInput()).env));
  });

  it("forwards no host value for a name env.set sets, so the env.set value stays", () => {
    const env = { allow: ["TERM", "EDITOR", "LANG"], set: { EDITOR: "vi" } };

    expect(forwardedNames(env)).toEqual(["TERM", "LANG"]);
    expect(forwardedEnv(forwardedNames(env), { TERM: "xterm", EDITOR: "nano", LANG: "C" })).toEqual({
      TERM: "xterm",
      LANG: "C",
    });
  });

  it("forwards only the allowlisted host variables that are set", () => {
    expect(forwardedEnv(["TERM", "LANG", "COLORFGBG"], { TERM: "xterm", LANG: "C", SECRET: "x" })).toEqual({
      TERM: "xterm",
      LANG: "C",
    });
  });

  it("guards only its read-only mounts, none of them inside the workspace root, and has no notice", () => {
    const workspace = { ...specInput().workspace, overlays: ["/work/repo/node_modules"] };
    const spec = buildContainerSpec(specInput({ workspace }));

    expect(spec.guardedPaths).toEqual(
      spec.mounts.filter((mount) => mount.readOnly && mount.kind === "bind").map((mount) => mount.target),
    );
    expect(spec.guardedPaths.filter((path) => path.startsWith("/work"))).toEqual([]);
    expect(mountAt(spec.mounts, "/work/repo/node_modules")?.kind).toBe("volume");
    expect(spec.notices).toEqual([]);
  });

  it("works in the repo root and carries the configured resources", () => {
    const config = sandboxConfig({
      resources: { cpus: 4, memoryGiB: 8, pids: 8192, openFiles: 65536, shmMiB: 1024 },
    });
    const spec = buildContainerSpec(specInput({ config }));

    expect(spec.workdir).toBe(repoRoot);
    expect(spec.resources).toEqual({ cpus: 4, memoryGiB: 8, pids: 8192, openFiles: 65536, shmMiB: 1024 });
  });

  it("leaves the open files and shm limits unset when the config sets none", () => {
    expect(buildContainerSpec(specInput()).resources).toEqual({
      cpus: undefined,
      memoryGiB: undefined,
      pids: 4096,
      openFiles: undefined,
      shmMiB: undefined,
    });
  });
});

describe("buildContainerSpec with host sessions", () => {
  const dir = "/Users/dev/.pi/agent/sessions/--work-repo--";

  it("binds the host session dir read-write at its own path and points pi at it", () => {
    const spec = buildContainerSpec(specInput({ hostSessions: { dir } }));

    expect(mountAt(spec.mounts, dir)).toEqual({ source: dir, target: dir, readOnly: false, kind: "bind" });
    expect(spec.env.PI_CODING_AGENT_SESSION_DIR).toBe(dir);
    expect(spec.labels["pi-sandbox.session-dir"]).toBe(dir);
    expect(mountAt(spec.mounts, "/home/pi/.pi/agent")?.kind).toBe("volume");
  });

  it("keeps sessions in the volume with no bind or env when off, and labels the reason", () => {
    const spec = buildContainerSpec(
      specInput({ hostSessions: { off: "sessions.host is off", notice: false } }),
    );

    expect(spec.mounts.some((mount) => mount.target.includes("/sessions/"))).toBe(false);
    expect(spec.env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(spec.labels["pi-sandbox.session-dir"]).toBe("sessions.host is off");
  });
});

describe("buildContainerSpec behind a linked agent dir", () => {
  it("binds the real paths of the session dir and the render dir, which the VM shares", () => {
    const real = join(scratch, "real-agent");
    const linked = join(scratch, "linked-agent");

    mkdirSync(join(real, "sessions", "--work-repo--"), { recursive: true });
    mkdirSync(join(real, "state", "vm", "render"), { recursive: true });
    symlinkSync(real, linked);

    const dir = join(linked, "sessions", "--work-repo--");
    const spec = buildContainerSpec(
      specInput({
        hostSessions: { dir },
        renderDir: join(linked, "state", "vm", "render"),
      }),
    );

    expect(mountAt(spec.mounts, dir)?.source).toBe(join(real, "sessions", "--work-repo--"));
    expect(mountAt(spec.mounts, "/opt/pi-sandbox/render")?.source).toBe(join(real, "state", "vm", "render"));
    expect(spec.env.PI_CODING_AGENT_SESSION_DIR).toBe(dir);
  });
});

describe("buildContainerSpec with services", () => {
  const services = [{ name: "db", command: ["db"], volumes: [{ name: "data", target: "/var/lib/db" }] }];
  const volumes = [
    { target: "/opt/data", name: "data" },
    { target: "/opt/other", name: "other" },
  ];

  it("stays on the repo network with services", () => {
    const spec = buildContainerSpec(specInput({ config: sandboxConfig({ services }), servicePorts: [5432] }));

    expect(spec.network).toEqual(proxy.network);
  });

  it("hands the forwarder the services' ports and their host", () => {
    const spec = buildContainerSpec(specInput({ servicePorts: [5432, 6379] }));

    expect(spec.env).toMatchObject({
      PI_SANDBOX_SERVICE_PORTS: "5432 6379",
      PI_SANDBOX_SERVICES_HOST: "pi-sandbox-services",
    });
  });

  it("starts no forwarder without ports", () => {
    const spec = buildContainerSpec(specInput({ servicePorts: [] }));

    expect(spec.env.PI_SANDBOX_SERVICE_PORTS).toBeUndefined();
    expect(spec.env.PI_SANDBOX_SERVICES_HOST).toBeUndefined();
    expect(buildContainerSpec(specInput()).env.PI_SANDBOX_SERVICE_PORTS).toBeUndefined();
  });

  it("leaves a service volume it also mounts to the service's owner", () => {
    const spec = buildContainerSpec(specInput({ config: sandboxConfig({ services, mounts: { volumes } }) }));

    expect(spec.ownedPaths).toEqual(["/opt/other"]);
    expect(
      buildContainerSpec(specInput({ config: sandboxConfig({ mounts: { volumes } }) })).ownedPaths,
    ).toEqual(["/opt/data", "/opt/other"]);
  });
});
