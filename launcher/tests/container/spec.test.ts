import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MountSpec } from "../../backend/index.ts";
import {
  buildContainerSpec,
  forwardedEnv,
  overlayVolumes,
  repoVolumes,
  sharedCacheVolumes,
} from "../../container/index.ts";
import type { ContainerSpecInput } from "../../container/spec.ts";
import { isLauncherSetVariable, sha256Hex } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const repoRoot = "/work/repo";

const repoHash = sha256Hex(repoRoot);

const proxy = {
  url: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
  network: { kind: "internal" as const, name: "pi-sandbox" },
};

const launchId = "0123456789abcdef";

const trust = { pemPath: "/state/ca/trust.pem", hash: "trust-1" };

const specInput = (overrides: Partial<ContainerSpecInput> = {}): ContainerSpecInput => ({
  workspace: { cwd: "/work/repo/src", repoRoot, gitCommonDir: "/work/repo/.git", isGitRepo: true },
  config: sandboxConfig(),
  image: { reference: "ghcr.io/zharskiy/pi-sandbox:0.4.0", digest: "sha256:abc", id: "sha256:image-abc" },
  hostUid: 501,
  stateDir: "/state",
  launchId,
  proxy,
  trust,
  gitOverlay: { selfBinds: [], readOnlyDirs: [] },
  ...overrides,
});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-spec-")));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const mountAt = (mounts: MountSpec[], target: string) => mounts.find((mount) => mount.target === target);

const withNestedRepo = {
  cwd: repoRoot,
  repoRoot,
  isGitRepo: false,
  nested: [
    {
      cwd: "/work/repo/api",
      repoRoot: "/work/repo/api",
      gitCommonDir: "/work/repo/api/.git",
      isGitRepo: true,
    },
  ],
};

describe("buildContainerSpec", () => {
  it("names the container after the repo hash and the launch", () => {
    expect(buildContainerSpec(specInput()).name).toBe(`pi-sandbox-${repoHash.slice(0, 12)}-${launchId}`);
  });

  it("labels the container with its repo, its launch and its image", () => {
    expect(buildContainerSpec(specInput()).labels).toEqual({
      "pi-sandbox.managed": "true",
      "pi-sandbox.repo-hash": repoHash,
      "pi-sandbox.repo-root": repoRoot,
      "pi-sandbox.launch-id": launchId,
      "pi-sandbox.image-digest": "sha256:abc",
      "pi-sandbox.image-reference": "ghcr.io/zharskiy/pi-sandbox:0.4.0",
    });
  });

  it("creates the container from the image id", () => {
    expect(buildContainerSpec(specInput()).image).toBe("sha256:image-abc");
  });

  it("binds the repo read-write at the same path and skips a git dir nested inside it", () => {
    const writable = buildContainerSpec(specInput()).mounts.filter(
      (mount) => !mount.readOnly && mount.kind === "bind",
    );

    expect(writable).toEqual([{ source: repoRoot, target: repoRoot, readOnly: false, kind: "bind" }]);
  });

  it("binds a git common dir outside the repo read-write at the same path", () => {
    const workspace = {
      cwd: "/work/wt",
      repoRoot: "/work/wt",
      gitCommonDir: "/work/main/.git",
      isGitRepo: true,
    };
    const mounts = buildContainerSpec(specInput({ workspace })).mounts;

    expect(mountAt(mounts, "/work/wt")).toEqual({
      source: "/work/wt",
      target: "/work/wt",
      readOnly: false,
      kind: "bind",
    });
    expect(mountAt(mounts, "/work/main/.git")).toEqual({
      source: "/work/main/.git",
      target: "/work/main/.git",
      readOnly: false,
      kind: "bind",
    });
  });

  it("binds the git dirs onto themselves and the protected dirs read-only from the host", () => {
    const gitOverlay = {
      selfBinds: ["/work/repo/.git", "/work/repo/.git/modules"],
      readOnlyDirs: ["/work/repo/.git/hooks"],
    };
    const mounts = buildContainerSpec(specInput({ gitOverlay })).mounts;

    expect(mountAt(mounts, "/work/repo/.git")).toEqual({
      source: "/work/repo/.git",
      target: "/work/repo/.git",
      readOnly: false,
      kind: "bind",
    });
    expect(mountAt(mounts, "/work/repo/.git/modules")?.readOnly).toBe(false);
    expect(mountAt(mounts, "/work/repo/.git/hooks")).toEqual({
      source: "/work/repo/.git/hooks",
      target: "/work/repo/.git/hooks",
      readOnly: true,
      kind: "bind",
    });
    expect(mounts.some((mount) => mount.source.startsWith("/state/repos/"))).toBe(false);
    expect(mounts.map((mount) => mount.target).indexOf("/work/repo/.git")).toBe(1);
  });

  it("needs no git mounts outside git", () => {
    const workspace = { cwd: "/work/plain", repoRoot: "/work/plain", isGitRepo: false };
    const spec = buildContainerSpec(specInput({ workspace }));

    expect(spec.mounts.filter((mount) => mount.target.includes(".git"))).toEqual([]);
  });

  it("keeps pi's agent dir on a named volume per user account and repository, whatever USER says", () => {
    const agentVolume = `pi-sandbox-agent-${sha256Hex(userInfo().username).slice(0, 12)}-${repoHash.slice(0, 12)}`;
    const other = { cwd: "/work/other", repoRoot: "/work/other", isGitRepo: false };

    expect(mountAt(buildContainerSpec(specInput()).mounts, "/home/pi/.pi/agent")).toEqual({
      source: agentVolume,
      target: "/home/pi/.pi/agent",
      readOnly: false,
      kind: "volume",
    });
    expect(
      mountAt(buildContainerSpec(specInput({ workspace: other })).mounts, "/home/pi/.pi/agent")?.source,
    ).not.toBe(agentVolume);
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

    expect(repoVolumes({ workspace: input.workspace, config, uid: 501 })).toEqual(volumes);
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

    expect(overlayVolumes(workspace, config)).toEqual([
      {
        path: "/work/repo/node_modules",
        name: `pi-sandbox-cache-${repoHash.slice(0, 12)}-${sha256Hex("node_modules").slice(0, 8)}`,
      },
      {
        path: "/work/repo/api/.venv",
        name: `pi-sandbox-cache-${repoHash.slice(0, 12)}-${sha256Hex("api/.venv").slice(0, 8)}`,
      },
    ]);
    expect(mountAt(mounts, "/work/repo/api/.venv")).toMatchObject({ kind: "volume", readOnly: false });
    expect(repoVolumes({ workspace, config, uid: 501 })).toEqual(
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

    expect(overlayVolumes(workspace, sandboxConfig({ mounts: { autoOverlays: false } }))).toEqual([]);
  });

  it("starts only while the deepest mount over each overlay folder is a volume or read-only and no writable bind lies inside", () => {
    const venv = "/work/repo/api/.venv";
    const workspace = { ...withNestedRepo, overlays: [venv] };
    const refusal = {
      message: `workspace: the sandbox could write in ${venv}, which the launcher did not search for repositories, refusing`,
      hint: "set mounts.autoOverlays to false so the launcher searches it, or start pi in a narrower folder",
    };
    const attempt = (input: Partial<ContainerSpecInput>) => () =>
      buildContainerSpec(specInput({ workspace, ...input }));
    const overlay = (selfBinds: string[], readOnlyDirs: string[] = []) => ({
      gitOverlay: { selfBinds, readOnlyDirs },
    });

    expect(mountAt(buildContainerSpec(specInput({ workspace })).mounts, venv)?.kind).toBe("volume");
    expect(attempt(overlay([], [join(venv, "hooks")]))).not.toThrow();
    expect(attempt(overlay([join(venv, "tools")]))).toThrow(expect.objectContaining(refusal));
  });

  it("refuses a writable bind that re-exposes an overlay folder below a read-only mount", () => {
    const target = "/work/repo/a/b/target";
    const below = buildContainerSpec.bind(
      undefined,
      specInput({
        workspace: { ...withNestedRepo, overlays: [target] },
        gitOverlay: { selfBinds: ["/work/repo/a/b"], readOnlyDirs: ["/work/repo/a"] },
      }),
    );

    expect(below).toThrow(`workspace: the sandbox could write in ${target}`);
  });

  it("compares mount depth on normalised targets and refuses when a writable bind shares the deepest target", () => {
    const target = "/work/repo/a/b/target";
    const attempt = (gitOverlay: ContainerSpecInput["gitOverlay"]) => () =>
      buildContainerSpec(specInput({ workspace: { ...withNestedRepo, overlays: [target] }, gitOverlay }));

    expect(
      attempt({
        selfBinds: ["/work/repo/a/b"],
        readOnlyDirs: ["/work/repo/a/./././././."],
      }),
    ).toThrow(`workspace: the sandbox could write in ${target}`);
    expect(attempt({ selfBinds: ["/work/repo/a"], readOnlyDirs: ["/work/repo/a/b/../"] })).toThrow(
      "workspace: the sandbox would mount /work/repo/a/b/../ twice, refusing",
    );
    expect(attempt({ selfBinds: ["/work/repo/a"], readOnlyDirs: ["/work/repo/a/b/"] })).not.toThrow();
  });

  it("refuses a folder whose mount would cover a path the sandbox image needs", () => {
    const at = (repoRoot: string) => () =>
      buildContainerSpec(specInput({ workspace: { cwd: repoRoot, repoRoot, isGitRepo: false, nested: [] } }));

    expect(at("/usr/local")).toThrow(
      "workspace: the sandbox would mount /usr/local over /usr/local/bin, which the sandbox image needs, refusing",
    );
    expect(at("/opt")).toThrow("over /opt/pi-sandbox");
    expect(at("/usr/local/src/app")).not.toThrow();
  });

  it("mounts a shared cache at its home path under one name for every repository of the same state dir", () => {
    const config = sandboxConfig({ mounts: { sharedCaches: ["~/.cache/pip/"] } });
    const other = { cwd: "/work/other", repoRoot: "/work/other", isGitRepo: false };
    const name = `pi-sandbox-shared-${sha256Hex("/state").slice(0, 12)}-${sha256Hex("~/.cache/pip").slice(0, 8)}`;
    const first = buildContainerSpec(specInput({ config }));
    const second = buildContainerSpec(specInput({ config, workspace: other }));

    expect(sharedCacheVolumes(config, "/state")).toEqual([{ path: "~/.cache/pip", name }]);
    expect(mountAt(first.mounts, "/home/pi/.cache/pip")).toEqual({
      source: name,
      target: "/home/pi/.cache/pip",
      readOnly: false,
      kind: "volume",
    });
    expect(mountAt(second.mounts, "/home/pi/.cache/pip")?.source).toBe(name);
    expect(sharedCacheVolumes(config, "/other-state")[0]?.name).not.toBe(name);
    expect(repoVolumes({ workspace: other, config, uid: 501 })).not.toContain(name);
  });

  it("mounts the render dir read-only at the guest render path, and only when given", () => {
    expect(mountAt(buildContainerSpec(specInput()).mounts, "/opt/pi-sandbox/render")).toBeUndefined();
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

  it("mounts the trust bundle read-only and carries its hash in the env", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.mounts.filter((mount) => mount.target === "/etc/pi-sandbox/ca.pem")).toEqual([
      { source: "/state/ca/trust.pem", target: "/etc/pi-sandbox/ca.pem", readOnly: true, kind: "bind" },
    ]);
    expect(spec.env).toMatchObject({
      NODE_EXTRA_CA_CERTS: "/etc/pi-sandbox/ca.pem",
      PI_SANDBOX_TRUST_HASH: "trust-1",
    });
  });

  it("names the proxy by its network alias, so a relay recreated for a new proxy port keeps working", () => {
    const spec = buildContainerSpec(specInput());

    expect(new URL(spec.env.HTTPS_PROXY ?? "").hostname).toBe("pi-sandbox-proxy");
    expect(spec.env.HTTP_PROXY).toBe(spec.env.HTTPS_PROXY);
    expect(spec.env.ALL_PROXY).toBe(spec.env.HTTPS_PROXY);
  });

  it("points JVMs at the proxy alias with Basic proxy auth, leaving the trust flags to the entrypoint", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.env.JAVA_TOOL_OPTIONS?.split(" ")).toEqual([
      "-Dhttps.proxyHost=pi-sandbox-proxy",
      "-Dhttps.proxyPort=3128",
      "-Dhttps.proxyUser=pi-sandbox",
      "-Dhttps.proxyPassword=token-1",
      "-Dhttp.proxyHost=pi-sandbox-proxy",
      "-Dhttp.proxyPort=3128",
      "-Dhttp.proxyUser=pi-sandbox",
      "-Dhttp.proxyPassword=token-1",
      "-Djdk.http.auth.tunneling.disabledSchemes=",
      "-Djdk.http.auth.proxying.disabledSchemes=",
    ]);
    expect(spec.env.JAVA_TOOL_OPTIONS).not.toContain("javax.net.ssl");
    expect(spec.env.https_proxy).toBe(spec.env.HTTPS_PROXY);
    expect(spec.env.no_proxy).toBe("localhost,127.0.0.1,::1");
    expect(spec.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(spec.env.PIP_CERT).toBe("/tmp/pi-sandbox/ca-bundle.pem");
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
      HTTPS_PROXY: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      HTTP_PROXY: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      ALL_PROXY: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      NO_PROXY: "localhost,127.0.0.1,::1",
      https_proxy: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      http_proxy: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      all_proxy: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      PI_SANDBOX_PROXY_HOST: "pi-sandbox-proxy",
      PI_SANDBOX_PROXY_PORT: "3128",
      PI_SANDBOX_PROXY_TOKEN: "token-1",
      JAVA_TOOL_OPTIONS: expect.any(String),
      NODE_EXTRA_CA_CERTS: "/etc/pi-sandbox/ca.pem",
      PI_SANDBOX_TRUST_HASH: "trust-1",
      SSL_CERT_FILE: "/tmp/pi-sandbox/ca-bundle.pem",
      REQUESTS_CA_BUNDLE: "/tmp/pi-sandbox/ca-bundle.pem",
      PIP_CERT: "/tmp/pi-sandbox/ca-bundle.pem",
      CARGO_HTTP_CAINFO: "/tmp/pi-sandbox/ca-bundle.pem",
      GIT_SSL_CAINFO: "/tmp/pi-sandbox/ca-bundle.pem",
      GIT_TERMINAL_PROMPT: "0",
      PI_SANDBOX: "1",
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
        toolEnv: { GH_TOKEN: "pi-sandbox-gh", GITLAB_TOKEN: "pi-sandbox-gl", GITLAB_HOST: "gitlab.com" },
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

  it("forwards only the allowlisted host variables that are set", () => {
    expect(forwardedEnv(["TERM", "LANG", "COLORFGBG"], { TERM: "xterm", LANG: "C", SECRET: "x" })).toEqual({
      TERM: "xterm",
      LANG: "C",
    });
  });

  it("leaves out a build output overlay inside a read-only git dir with a notice, and still starts", () => {
    const repo = join(scratch, "overlay-repo");

    mkdirSync(join(repo, "vendor", "pkg"), { recursive: true });

    const vendor = join(repo, "vendor");
    const workspace = {
      cwd: repo,
      repoRoot: repo,
      isGitRepo: false,
      overlays: [join(vendor, "pkg", "node_modules"), join(repo, "node_modules")],
    };
    const gitOverlay = { selfBinds: [], readOnlyDirs: [vendor] };
    const spec = buildContainerSpec(specInput({ workspace, gitOverlay }));

    expect(mountAt(spec.mounts, join(vendor, "pkg", "node_modules"))).toBeUndefined();
    expect(mountAt(spec.mounts, join(repo, "node_modules"))?.kind).toBe("volume");
    expect(Object.keys(spec.volumeLabels)).toHaveLength(2);
    expect(spec.ownedPaths).toEqual([join(repo, "node_modules")]);
    expect(spec.notices).toEqual([
      `${join(vendor, "pkg", "node_modules")} is not overlaid: it lies inside ${vendor}, which the sandbox protects`,
    ]);
  });

  it("leaves out a build output overlay inside a read-only git path and has no notice otherwise", () => {
    const workspace = {
      cwd: repoRoot,
      repoRoot,
      gitCommonDir: "/work/repo/.git",
      isGitRepo: true,
      overlays: ["/work/repo/.githooks/node_modules"],
    };
    const gitOverlay = { selfBinds: [], readOnlyDirs: ["/work/repo/.githooks"] };
    const spec = buildContainerSpec(specInput({ workspace, gitOverlay }));

    expect(mountAt(spec.mounts, "/work/repo/.githooks/node_modules")).toBeUndefined();
    expect(spec.notices).toHaveLength(1);
    expect(buildContainerSpec(specInput()).notices).toBeUndefined();
  });

  it("lists the read-only targets and git dirs a mount point may not be created in", () => {
    const gitOverlay = {
      selfBinds: ["/work/repo/.git"],
      readOnlyDirs: ["/work/repo/.git/hooks"],
    };

    expect(buildContainerSpec(specInput({ gitOverlay })).guardedPaths).toEqual(
      expect.arrayContaining(["/work/repo/.git/hooks", "/work/repo/.git", "/etc/pi-sandbox/ca.pem"]),
    );
  });

  it("works in the repo root and carries the configured resources", () => {
    const config = sandboxConfig({ resources: { cpus: 4, memoryGiB: 8 } });
    const spec = buildContainerSpec(specInput({ config }));

    expect(spec.workdir).toBe(repoRoot);
    expect(spec.resources).toEqual({ cpus: 4, memoryGiB: 8 });
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
