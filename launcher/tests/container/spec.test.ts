import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MountSpec } from "../../backend/index.ts";
import type { SandboxConfig } from "../../config/index.ts";
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
  tokenHash: "token-hash-1",
};

const trust = { pemPath: "/state/ca/trust.pem", hash: "trust-1" };

const specInput = (overrides: Partial<ContainerSpecInput> = {}): ContainerSpecInput => ({
  workspace: { cwd: "/work/repo/src", repoRoot, gitCommonDir: "/work/repo/.git", isGitRepo: true },
  config: sandboxConfig(),
  image: { reference: "ghcr.io/zharskiy/pi-sandbox:0.4.0", digest: "sha256:abc", id: "sha256:image-abc" },
  hostEnv: {
    USER: "dev",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LLM_API_KEY: "real-secret-value-1234567890",
    HOME: "/Users/dev",
  },
  hostUid: 501,
  stateDir: "/state",
  proxy,
  trust,
  gitOverlay: { selfBinds: [], readOnlyDirs: [], readOnlyFiles: [] },
  launcherVersion: "0.4.0",
  ...overrides,
});

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "pi-sandbox-spec-")));

const hostHome = join(scratch, "home");

const sharedDir = join(scratch, "opt", "shared");

mkdirSync(join(hostHome, "libs"), { recursive: true });

mkdirSync(sharedDir, { recursive: true });

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const LABELS_SPEC_HASH = "pi-sandbox.spec-hash";

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
  it("names the container after the repo hash", () => {
    expect(buildContainerSpec(specInput()).name).toBe(`pi-sandbox-${repoHash.slice(0, 12)}`);
  });

  it("labels the container with repo, image, proxy token hash and launcher identity", () => {
    expect(buildContainerSpec(specInput()).labels).toMatchObject({
      "pi-sandbox.repo-hash": repoHash,
      "pi-sandbox.repo-root": repoRoot,
      "pi-sandbox.image-digest": "sha256:abc",
      "pi-sandbox.image-reference": "ghcr.io/zharskiy/pi-sandbox:0.4.0",
      "pi-sandbox.proxy-token-hash": "token-hash-1",
      "pi-sandbox.version": "0.4.0",
    });
  });

  it("labels a spec hash that changes with the spec and nothing else", () => {
    const hashOf = (input: ContainerSpecInput) => buildContainerSpec(input).labels["pi-sandbox.spec-hash"];
    const base = hashOf(specInput());
    const extra = sandboxConfig({ mounts: { extraReadOnly: [sharedDir], cacheVolumes: [] } });

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(specInput())).toBe(base);
    expect(hashOf(specInput({ config: extra }))).not.toBe(base);
    expect(
      hashOf(specInput({ proxy: { ...proxy, url: "http://pi-sandbox:token-2@pi-sandbox-proxy:3128" } })),
    ).not.toBe(base);
  });

  it("changes the spec hash with each config field that shapes the container", () => {
    const hashOf = (input: ContainerSpecInput) => buildContainerSpec(input).labels["pi-sandbox.spec-hash"];
    const withConfig = (config: SandboxConfig) => hashOf(specInput({ config }));
    const base = hashOf(specInput());
    const changed = [
      withConfig(sandboxConfig({ mounts: { extraReadOnly: [sharedDir] } })),
      withConfig(sandboxConfig({ mounts: { cacheVolumes: ["/work/repo/.cache"] } })),
      withConfig(sandboxConfig({ resources: { cpus: 2 } })),
      withConfig(sandboxConfig({ resources: { memoryGiB: 4 } })),
      hashOf(specInput({ image: { reference: "other:1", digest: "sha256:def", id: "sha256:image-def" } })),
    ];

    expect(new Set([base, ...changed]).size).toBe(changed.length + 1);
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

  it("binds the git dirs onto themselves, hooks and pointers read-only from the host and config from a private copy", () => {
    const gitOverlay = {
      selfBinds: ["/work/repo/.git", "/work/repo/.git/modules"],
      readOnlyDirs: ["/work/repo/.git/hooks"],
      readOnlyFiles: ["/work/repo/.git/config", "/work/repo/.git/commondir"],
    };
    const mounts = buildContainerSpec(specInput({ gitOverlay })).mounts;
    const copies = `/state/repos/${repoHash}/git/`;

    expect(mountAt(mounts, "/work/repo/.git")).toEqual({
      source: "/work/repo/.git",
      target: "/work/repo/.git",
      readOnly: false,
      kind: "bind",
    });
    expect(mountAt(mounts, "/work/repo/.git/modules")?.readOnly).toBe(false);
    ["/work/repo/.git/hooks", "/work/repo/.git/commondir"].forEach((path) => {
      expect(mountAt(mounts, path)).toEqual({ source: path, target: path, readOnly: true, kind: "bind" });
    });
    expect(mountAt(mounts, "/work/repo/.git/config")).toEqual({
      source: expect.stringMatching(new RegExp(`^${copies}[0-9a-f]{16}$`)),
      target: "/work/repo/.git/config",
      readOnly: true,
      kind: "bind",
    });
    expect(mounts.map((mount) => mount.target).indexOf("/work/repo/.git")).toBe(1);
  });

  it("needs no git mounts outside git", () => {
    const workspace = { cwd: "/work/plain", repoRoot: "/work/plain", isGitRepo: false };
    const spec = buildContainerSpec(specInput({ workspace }));

    expect(spec.mounts.filter((mount) => mount.target.includes(".git"))).toEqual([]);
  });

  it("adds the extra read-only mounts from config at the same path, with ~ expanded", () => {
    const repo = join(scratch, "repo");

    mkdirSync(join(repo, "vendor", "sdk"), { recursive: true });

    const config = sandboxConfig({
      mounts: { extraReadOnly: [sharedDir, "vendor/sdk", "~/libs"], cacheVolumes: [] },
    });
    const mounts = buildContainerSpec(
      specInput({
        config,
        workspace: { cwd: repo, repoRoot: repo, isGitRepo: false },
        hostEnv: { USER: "dev", HOME: hostHome },
      }),
    ).mounts;

    expect(mountAt(mounts, sharedDir)).toEqual({
      source: sharedDir,
      target: sharedDir,
      readOnly: true,
      kind: "bind",
    });
    expect(mountAt(mounts, join(repo, "vendor", "sdk"))?.readOnly).toBe(true);
    expect(mountAt(mounts, join(hostHome, "libs"))?.source).toBe(join(hostHome, "libs"));
    expect(mounts.some((mount) => mount.source.includes("~"))).toBe(false);
  });

  it("refuses an extra mount that would expose the engine socket or the home", () => {
    const socketDir = join(scratch, "engine");

    mkdirSync(socketDir, { recursive: true });

    const attempt = (path: string, hostEnv: Record<string, string>) => () =>
      buildContainerSpec(
        specInput({
          config: sandboxConfig({ mounts: { extraReadOnly: [path], cacheVolumes: [] } }),
          hostEnv: { USER: "dev", HOME: hostHome, ...hostEnv },
        }),
      );

    expect(attempt(socketDir, { DOCKER_HOST: `unix://${socketDir}/docker.sock` })).toThrow(
      `mounts.extraReadOnly: ${socketDir} is not allowed (it contains the container engine socket)`,
    );
    expect(attempt("~", {})).toThrow("mounts.extraReadOnly: ~ is not allowed (it is the home directory)");
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
    expect(
      mountAt(
        buildContainerSpec(specInput({ hostEnv: { USER: "someone-else" } })).mounts,
        "/home/pi/.pi/agent",
      )?.source,
    ).toBe(agentVolume);
  });

  it("lists the repository's agent and cache volumes", () => {
    const config = sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: ["node_modules"] } });
    const input = specInput({ config });
    const volumes = buildContainerSpec(input)
      .mounts.filter((mount) => mount.kind === "volume")
      .map((mount) => mount.source);

    expect(repoVolumes({ workspace: input.workspace, config, uid: 501 })).toEqual(volumes);
  });

  it("puts cache paths on per-repo named volumes", () => {
    const config = sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: ["node_modules"] } });

    expect(mountAt(buildContainerSpec(specInput({ config })).mounts, "/work/repo/node_modules")).toEqual({
      source: `pi-sandbox-cache-${repoHash.slice(0, 12)}-${sha256Hex("node_modules").slice(0, 8)}`,
      target: "/work/repo/node_modules",
      readOnly: false,
      kind: "volume",
    });
  });

  it("overlays the build output of every marker folder with a volume and leaves out those a cache covers", () => {
    const workspace = {
      cwd: repoRoot,
      repoRoot,
      gitCommonDir: "/work/repo/.git",
      isGitRepo: true,
      overlays: ["/work/repo/node_modules", "/work/repo/api/.venv", "/work/repo/vendor/lib/node_modules"],
    };
    const config = sandboxConfig({ mounts: { cacheVolumes: ["vendor"] } });
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
    expect(mountAt(mounts, "/work/repo/vendor/lib/node_modules")).toBeUndefined();
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
      gitOverlay: { selfBinds, readOnlyDirs, readOnlyFiles: [] },
    });

    expect(mountAt(buildContainerSpec(specInput({ workspace })).mounts, venv)?.kind).toBe("volume");
    expect(attempt({ config: sandboxConfig({ mounts: { cacheVolumes: ["api"] } }) })).not.toThrow();
    expect(attempt(overlay([], [join(venv, "hooks")]))).not.toThrow();
    expect(attempt(overlay([join(venv, "tools")]))).toThrow(expect.objectContaining(refusal));
  });

  it("refuses a writable bind that re-exposes an overlay folder below a read-only mount or a cache volume", () => {
    const target = "/work/repo/a/b/target";
    const below = buildContainerSpec.bind(
      undefined,
      specInput({
        workspace: { ...withNestedRepo, overlays: [target] },
        gitOverlay: { selfBinds: ["/work/repo/a/b"], readOnlyDirs: ["/work/repo/a"], readOnlyFiles: [] },
      }),
    );
    const worktree = "/work/repo/linked/wt";
    const cached = buildContainerSpec.bind(
      undefined,
      specInput({
        workspace: { ...withNestedRepo, overlays: [join(worktree, ".venv")] },
        config: sandboxConfig({ mounts: { cacheVolumes: ["linked"] } }),
        gitOverlay: { selfBinds: [worktree], readOnlyDirs: [], readOnlyFiles: [join(worktree, ".git")] },
      }),
    );

    expect(below).toThrow(`workspace: the sandbox could write in ${target}`);
    expect(cached).toThrow(`workspace: the sandbox could write in ${join(worktree, ".venv")}`);
  });

  it("compares mount depth on normalised targets and refuses when a writable bind shares the deepest target", () => {
    const target = "/work/repo/a/b/target";
    const attempt = (gitOverlay: ContainerSpecInput["gitOverlay"]) => () =>
      buildContainerSpec(specInput({ workspace: { ...withNestedRepo, overlays: [target] }, gitOverlay }));

    expect(
      attempt({
        selfBinds: ["/work/repo/a/b"],
        readOnlyDirs: ["/work/repo/a/./././././."],
        readOnlyFiles: [],
      }),
    ).toThrow(`workspace: the sandbox could write in ${target}`);
    expect(
      attempt({ selfBinds: ["/work/repo/a"], readOnlyDirs: ["/work/repo/a"], readOnlyFiles: [] }),
    ).toThrow(`workspace: the sandbox could write in ${target}`);
    expect(
      attempt({ selfBinds: ["/work/repo/a"], readOnlyDirs: ["/work/repo/a/b/"], readOnlyFiles: [] }),
    ).not.toThrow();
  });

  it("masks each unreadable folder with the launcher's empty folder, read-only", () => {
    const locked = "/work/repo/locked";
    const workspace = { ...withNestedRepo, masked: [locked] };
    const spec = buildContainerSpec(specInput({ workspace }));

    expect(mountAt(spec.mounts, locked)).toEqual({
      source: "/state/empty",
      target: locked,
      readOnly: true,
      kind: "bind",
    });
    expect(spec.guardedPaths).toContain(locked);
    expect(() =>
      buildContainerSpec(
        specInput({
          workspace,
          gitOverlay: { selfBinds: [join(locked, "a")], readOnlyDirs: [], readOnlyFiles: [] },
        }),
      ),
    ).toThrow(expect.objectContaining({ hint: `make ${locked} readable, or start pi in a narrower folder` }));
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

  it("binds host caches read-write at their guest paths and owns only their guest parents", () => {
    const hostCaches = [
      { preset: "maven" as const, source: "/Users/dev/.m2/repository", target: ".m2/repository" },
      { preset: "go" as const, source: "/Users/dev/go/pkg/mod", target: "go/pkg/mod" },
    ];
    const spec = buildContainerSpec(specInput({ hostCaches }));

    expect(mountAt(spec.mounts, "/home/pi/.m2/repository")).toEqual({
      source: "/Users/dev/.m2/repository",
      target: "/home/pi/.m2/repository",
      readOnly: false,
      kind: "bind",
    });
    expect(mountAt(spec.mounts, "/home/pi/go/pkg/mod")?.source).toBe("/Users/dev/go/pkg/mod");
    expect(spec.ownedPaths).toEqual(["/home/pi/.m2", "/home/pi/go", "/home/pi/go/pkg"]);
    expect(spec.mounts.map((mount) => mount.target)).not.toContain("/home/pi/.m2");
    expect(spec.labels[LABELS_SPEC_HASH]).not.toBe(buildContainerSpec(specInput()).labels[LABELS_SPEC_HASH]);
  });

  it("mounts no trust bundle and sets no CA variable without trust", () => {
    const withoutTrust = buildContainerSpec(specInput({ trust: undefined }));

    expect(mountAt(withoutTrust.mounts, "/etc/pi-sandbox/ca.pem")).toBeUndefined();
    expect(withoutTrust.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(withoutTrust.env.PI_SANDBOX_TRUST_HASH).toBeUndefined();
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

  it("recreates the container when the trust content changes", () => {
    const hashOf = (hash: string) =>
      buildContainerSpec(specInput({ trust: { pemPath: "/state/ca/trust.pem", hash } })).labels[
        "pi-sandbox.spec-hash"
      ];

    expect(hashOf("one")).toBe(hashOf("one"));
    expect(hashOf("one")).not.toBe(hashOf("two"));
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

  it("has no network and no proxy variables without a proxy", () => {
    const spec = buildContainerSpec(specInput({ proxy: undefined }));

    expect(spec.network).toEqual({ kind: "none" });
    expect(Object.keys(spec.env).filter((name) => /_proxy|PROXY_|JAVA_TOOL_OPTIONS/i.test(name))).toEqual([]);
    expect(spec.labels["pi-sandbox.proxy-token-hash"]).toBeUndefined();
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

  it("keeps the spec hash when only the forwarded terminal variables change", () => {
    const first = buildContainerSpec(specInput());
    const second = buildContainerSpec(
      specInput({ hostEnv: { USER: "dev", TERM: "xterm-kitty", TERM_PROGRAM: "other", COLORFGBG: "0;15" } }),
    );

    expect(second.labels["pi-sandbox.spec-hash"]).toBe(first.labels["pi-sandbox.spec-hash"]);
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

  it("forwards only the allowlisted host variables that are set", () => {
    expect(forwardedEnv(["TERM", "LANG", "COLORFGBG"], { TERM: "xterm", LANG: "C", SECRET: "x" })).toEqual({
      TERM: "xterm",
      LANG: "C",
    });
  });

  it("names one cache volume per resolved target, however the path is written", () => {
    const config = sandboxConfig({
      mounts: { cacheVolumes: ["node_modules", "./node_modules", "node_modules/"] },
    });
    const volumes = buildContainerSpec(specInput({ config })).mounts.filter(
      (mount) => mount.target === "/work/repo/node_modules",
    );

    expect(volumes).toEqual([
      {
        source: `pi-sandbox-cache-${repoHash.slice(0, 12)}-${sha256Hex("node_modules").slice(0, 8)}`,
        target: "/work/repo/node_modules",
        readOnly: false,
        kind: "volume",
      },
    ]);
  });

  it("refuses a cache volume inside a git dir or a read-only mount, naming the key", () => {
    const gitOverlay = {
      selfBinds: ["/work/repo/.git"],
      readOnlyDirs: ["/work/repo/.git/hooks", "/work/repo/.githooks"],
      readOnlyFiles: [],
    };
    const attempt = (cacheVolumes: string[]) => () =>
      buildContainerSpec(specInput({ gitOverlay, config: sandboxConfig({ mounts: { cacheVolumes } }) }));

    expect(attempt([".git/hooks/pre-commit"])).toThrow(
      "mounts.cacheVolumes: /work/repo/.git/hooks/pre-commit lies inside /work/repo/.git/hooks",
    );
    expect(attempt([".git/objects"])).toThrow(
      "mounts.cacheVolumes: /work/repo/.git/objects lies inside /work/repo/.git",
    );
    expect(attempt([".githooks/pre-push"])).toThrow("lies inside /work/repo/.githooks");
    expect(attempt([".githooks"])).toThrow("lies inside /work/repo/.githooks");
    expect(attempt(["node_modules"])).not.toThrow();
  });

  it("leaves out a build output overlay inside an extra read-only mount with a notice, and still starts", () => {
    const repo = join(scratch, "overlay-repo");

    mkdirSync(join(repo, "vendor", "pkg"), { recursive: true });

    const vendor = join(repo, "vendor");
    const workspace = {
      cwd: repo,
      repoRoot: repo,
      isGitRepo: false,
      overlays: [join(vendor, "pkg", "node_modules"), join(repo, "node_modules")],
    };
    const config = sandboxConfig({ mounts: { extraReadOnly: ["vendor"] } });
    const spec = buildContainerSpec(specInput({ workspace, config, hostEnv: { HOME: hostHome } }));

    expect(mountAt(spec.mounts, join(vendor, "pkg", "node_modules"))).toBeUndefined();
    expect(mountAt(spec.mounts, join(repo, "node_modules"))?.kind).toBe("volume");
    expect(Object.keys(spec.volumeLabels)).toHaveLength(2);
    expect(spec.ownedPaths).toEqual([join(repo, "node_modules")]);
    expect(spec.notices).toEqual([
      `${join(vendor, "pkg", "node_modules")} is not overlaid: it lies inside ${vendor}, which the sandbox protects`,
    ]);
    expect(() =>
      buildContainerSpec(
        specInput({
          workspace,
          config: sandboxConfig({ mounts: { extraReadOnly: ["vendor"], cacheVolumes: ["vendor/cache"] } }),
          hostEnv: { HOME: hostHome },
        }),
      ),
    ).toThrow(`mounts.cacheVolumes: ${join(vendor, "cache")} lies inside ${vendor}`);
  });

  it("leaves out a build output overlay inside a read-only git path and has no notice otherwise", () => {
    const workspace = {
      cwd: repoRoot,
      repoRoot,
      gitCommonDir: "/work/repo/.git",
      isGitRepo: true,
      overlays: ["/work/repo/.githooks/node_modules"],
    };
    const gitOverlay = { selfBinds: [], readOnlyDirs: ["/work/repo/.githooks"], readOnlyFiles: [] };
    const spec = buildContainerSpec(specInput({ workspace, gitOverlay }));

    expect(mountAt(spec.mounts, "/work/repo/.githooks/node_modules")).toBeUndefined();
    expect(spec.notices).toHaveLength(1);
    expect(buildContainerSpec(specInput()).notices).toBeUndefined();
  });

  it("lists the read-only targets and git dirs a mount point may not be created in", () => {
    const gitOverlay = {
      selfBinds: ["/work/repo/.git"],
      readOnlyDirs: ["/work/repo/.git/hooks"],
      readOnlyFiles: [],
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

  it("changes the spec hash when the toggle or the directory changes", () => {
    const hashOf = (input: ContainerSpecInput) => buildContainerSpec(input).labels["pi-sandbox.spec-hash"];
    const on = hashOf(specInput({ hostSessions: { dir } }));
    const off = hashOf(specInput({ hostSessions: { off: "sessions.host is off", notice: false } }));
    const moved = hashOf(specInput({ hostSessions: { dir: `${dir}-moved` } }));

    expect(new Set([on, off, moved]).size).toBe(3);
  });
});
