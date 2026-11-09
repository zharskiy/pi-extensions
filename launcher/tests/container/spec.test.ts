import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MountSpec } from "../../backend/index.ts";
import type { SandboxConfig } from "../../config/index.ts";
import {
  buildContainerSpec,
  forwardedEnv,
  nodeModulesOverlays,
  repoVolumes,
  sharedCacheVolumes,
} from "../../container/index.ts";
import type { ContainerSpecInput } from "../../container/spec.ts";
import { sha256Hex } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const repoRoot = "/work/repo";

const repoHash = sha256Hex(repoRoot);

const proxy = {
  url: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
  network: { kind: "internal" as const, name: "pi-sandbox" },
  tokenHash: "token-hash-1",
  caPemPath: "/state/ca/ca.pem",
};

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

  it("keeps pi's agent dir on a named volume per user and repository", () => {
    const agentVolume = `pi-sandbox-agent-${sha256Hex("dev").slice(0, 12)}-${repoHash.slice(0, 12)}`;
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

  it("lists the repository's agent and cache volumes", () => {
    const config = sandboxConfig({ mounts: { extraReadOnly: [], cacheVolumes: ["node_modules"] } });
    const input = specInput({ config });
    const volumes = buildContainerSpec(input)
      .mounts.filter((mount) => mount.kind === "volume")
      .map((mount) => mount.source);

    expect(repoVolumes({ workspace: input.workspace, config, hostEnv: input.hostEnv, uid: 501 })).toEqual(
      volumes,
    );
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

  it("overlays node_modules of every node project with a volume and leaves out those a cache covers", () => {
    const workspace = {
      cwd: repoRoot,
      repoRoot,
      gitCommonDir: "/work/repo/.git",
      isGitRepo: true,
      nodeProjects: [repoRoot, "/work/repo/web", "/work/repo/vendor/lib"],
    };
    const config = sandboxConfig({ mounts: { cacheVolumes: ["vendor"] } });
    const input = specInput({ workspace, config });
    const mounts = buildContainerSpec(input).mounts;

    expect(nodeModulesOverlays(workspace, config)).toEqual([
      {
        path: "/work/repo/node_modules",
        name: `pi-sandbox-cache-${repoHash.slice(0, 12)}-${sha256Hex("node_modules").slice(0, 8)}`,
      },
      {
        path: "/work/repo/web/node_modules",
        name: `pi-sandbox-cache-${repoHash.slice(0, 12)}-${sha256Hex("web/node_modules").slice(0, 8)}`,
      },
    ]);
    expect(mountAt(mounts, "/work/repo/web/node_modules")).toMatchObject({ kind: "volume", readOnly: false });
    expect(mountAt(mounts, "/work/repo/vendor/lib/node_modules")).toBeUndefined();
    expect(repoVolumes({ workspace, config, hostEnv: input.hostEnv, uid: 501 })).toEqual(
      mounts.filter((mount) => mount.kind === "volume").map((mount) => mount.source),
    );
  });

  it("keeps host node_modules visible when the overlay is off", () => {
    const workspace = { cwd: repoRoot, repoRoot, isGitRepo: false, nodeProjects: ["/work/repo/web"] };
    const off = sandboxConfig({ mounts: { autoNodeModules: false } });
    const plain = buildContainerSpec(
      specInput({ workspace: { cwd: repoRoot, repoRoot, isGitRepo: false }, config: off }),
    );

    expect(nodeModulesOverlays(workspace, off)).toEqual([]);
    expect(buildContainerSpec(specInput({ workspace, config: off })).labels[LABELS_SPEC_HASH]).toBe(
      plain.labels[LABELS_SPEC_HASH],
    );
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
    expect(repoVolumes({ workspace: other, config, hostEnv: {}, uid: 501 })).not.toContain(name);
  });

  it("mounts the proxy CA read-only when the proxy has one, and only then", () => {
    const withoutCa = buildContainerSpec(specInput({ proxy: { ...proxy, caPemPath: undefined } }));

    expect(mountAt(withoutCa.mounts, "/etc/pi-sandbox/ca.pem")).toBeUndefined();
    expect(withoutCa.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(mountAt(buildContainerSpec(specInput()).mounts, "/etc/pi-sandbox/ca.pem")).toEqual({
      source: "/state/ca/ca.pem",
      target: "/etc/pi-sandbox/ca.pem",
      readOnly: true,
      kind: "bind",
    });
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

  it("mounts the trust bundle in place of the proxy CA and carries its hash in the env", () => {
    const trust = { pemPath: "/state/ca/trust.pem", hash: "trust-1" };
    const spec = buildContainerSpec(specInput({ trust }));

    expect(spec.mounts.filter((mount) => mount.target === "/etc/pi-sandbox/ca.pem")).toEqual([
      { source: "/state/ca/trust.pem", target: "/etc/pi-sandbox/ca.pem", readOnly: true, kind: "bind" },
    ]);
    expect(spec.env).toMatchObject({
      NODE_EXTRA_CA_CERTS: "/etc/pi-sandbox/ca.pem",
      PI_SANDBOX_TRUST_HASH: "trust-1",
    });
  });

  it("mounts the trust bundle even without a proxy CA", () => {
    const spec = buildContainerSpec(
      specInput({
        proxy: { ...proxy, caPemPath: undefined },
        trust: { pemPath: "/state/ca/trust.pem", hash: "h" },
      }),
    );

    expect(mountAt(spec.mounts, "/etc/pi-sandbox/ca.pem")?.source).toBe("/state/ca/trust.pem");
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
    expect(spec.env.no_proxy).toBe("");
    expect(spec.env.PIP_CERT).toBe("/tmp/pi-sandbox/ca-bundle.pem");
  });

  it("marks the sandbox and never sets pi offline", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.env.PI_SANDBOX).toBe("1");
    expect(spec.env.PI_OFFLINE).toBeUndefined();
  });

  it("keeps the launch id out of the spec and its hash", () => {
    const first = buildContainerSpec(specInput({ launchId: "aaaaaaaaaaaaaaaa" }));
    const second = buildContainerSpec(specInput({ launchId: "bbbbbbbbbbbbbbbb" }));

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("aaaaaaaaaaaaaaaa");
  });

  it("runs with a read-only root, tmpfs for /tmp and home, and an init process", () => {
    const spec = buildContainerSpec(specInput());

    expect(spec.readOnlyRoot).toBe(true);
    expect(spec.tmpfs.map((entry) => entry.split(":")[0])).toEqual(["/tmp", "/home/pi"]);
    expect(spec.init).toBe(true);
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
      NO_PROXY: "",
      https_proxy: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      http_proxy: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      all_proxy: "http://pi-sandbox:token-1@pi-sandbox-proxy:3128",
      no_proxy: "",
      NODE_USE_ENV_PROXY: "1",
      PI_SANDBOX_PROXY_HOST: "pi-sandbox-proxy",
      PI_SANDBOX_PROXY_PORT: "3128",
      PI_SANDBOX_PROXY_TOKEN: "token-1",
      JAVA_TOOL_OPTIONS: expect.any(String),
      NODE_EXTRA_CA_CERTS: "/etc/pi-sandbox/ca.pem",
      SSL_CERT_FILE: "/tmp/pi-sandbox/ca-bundle.pem",
      REQUESTS_CA_BUNDLE: "/tmp/pi-sandbox/ca-bundle.pem",
      PIP_CERT: "/tmp/pi-sandbox/ca-bundle.pem",
      CARGO_HTTP_CAINFO: "/tmp/pi-sandbox/ca-bundle.pem",
      GIT_SSL_CAINFO: "/tmp/pi-sandbox/ca-bundle.pem",
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

  it("forwards only the allowlisted host variables that are set", () => {
    expect(forwardedEnv(["TERM", "LANG", "COLORFGBG"], { TERM: "xterm", LANG: "C", SECRET: "x" })).toEqual({
      TERM: "xterm",
      LANG: "C",
    });
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
