import { describe, expect, it } from "vitest";
import type { BackendCapabilities, MountSpec } from "../../backend/index.ts";
import { buildContainerSpec, forwardedEnv, repoVolumes } from "../../container/index.ts";
import type { ContainerSpecInput } from "../../container/spec.ts";
import { sha256Hex } from "../../shared/index.ts";
import { sandboxConfig } from "../support/sandbox-config.ts";

const repoRoot = "/work/repo";

const repoHash = sha256Hex(repoRoot);

const capabilities: BackendCapabilities = {
  singleFileMount: true,
  sshAgent: true,
  internalNetwork: true,
};

const proxy = {
  url: "http://pi-sandbox:token-1@10.89.0.2:3128",
  network: { kind: "internal" as const, name: "pi-sandbox" },
  policyHash: "policy-1",
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
    GATEWAY_API_KEY: "real-secret-value-1234567890",
    HOME: "/Users/dev",
  },
  hostUid: 501,
  hostGid: 20,
  platform: "darwin",
  capabilities,
  stateDir: "/state",
  proxy,
  launcherVersion: "0.4.0",
  configHash: "cfg123",
  ...overrides,
});

const mountAt = (mounts: MountSpec[], target: string) => mounts.find((mount) => mount.target === target);

describe("buildContainerSpec", () => {
  it("names the container after the repo hash", () => {
    expect(buildContainerSpec(specInput()).name).toBe(`pi-sandbox-${repoHash.slice(0, 12)}`);
  });

  it("labels the container with repo, image, config, proxy policy and launcher identity", () => {
    expect(buildContainerSpec(specInput()).labels).toMatchObject({
      "pi-sandbox.repo-hash": repoHash,
      "pi-sandbox.repo-root": repoRoot,
      "pi-sandbox.image-digest": "sha256:abc",
      "pi-sandbox.image-reference": "ghcr.io/zharskiy/pi-sandbox:0.4.0",
      "pi-sandbox.config-hash": "cfg123",
      "pi-sandbox.proxy-policy-hash": "policy-1",
      "pi-sandbox.version": "0.4.0",
    });
  });

  it("labels a spec hash that changes with the spec and nothing else", () => {
    const hashOf = (input: ContainerSpecInput) => buildContainerSpec(input).labels["pi-sandbox.spec-hash"];
    const base = hashOf(specInput());
    const extra = sandboxConfig({ mounts: { extraReadOnly: ["/opt/tools"], cacheVolumes: [] } });

    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(specInput())).toBe(base);
    expect(hashOf(specInput({ config: extra }))).not.toBe(base);
    expect(
      hashOf(specInput({ proxy: { ...proxy, url: "http://pi-sandbox:token-2@10.89.0.2:3128" } })),
    ).not.toBe(base);
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

  it("overlays git hooks and config read-only", () => {
    const mounts = buildContainerSpec(specInput()).mounts;

    expect(mountAt(mounts, "/work/repo/.git/hooks")).toEqual({
      source: "/work/repo/.git/hooks",
      target: "/work/repo/.git/hooks",
      readOnly: true,
      kind: "bind",
    });
    expect(mountAt(mounts, "/work/repo/.git/config")).toEqual({
      source: "/work/repo/.git/config",
      target: "/work/repo/.git/config",
      readOnly: true,
      kind: "bind",
    });
  });

  it("overlays the discovered hooks path, submodule and worktree git files read-only", () => {
    const gitOverlay = {
      dirs: ["/work/repo/.githooks", "/work/repo/.git/modules/lib/hooks"],
      files: ["/work/repo/.git/modules/lib/config", "/work/repo/.git/worktrees/wt/config.worktree"],
    };
    const mounts = buildContainerSpec(specInput({ gitOverlay })).mounts;

    [...gitOverlay.dirs, ...gitOverlay.files].forEach((path) => {
      expect(mountAt(mounts, path)).toEqual({ source: path, target: path, readOnly: true, kind: "bind" });
    });
  });

  it("asks for copies of the git files in the spec's copies dir when the backend cannot mount single files", () => {
    const gitOverlay = { dirs: [], files: ["/work/repo/.git/worktrees/wt/config.worktree"] };
    const spec = buildContainerSpec(
      specInput({ gitOverlay, capabilities: { ...capabilities, singleFileMount: false } }),
    );

    expect(mountAt(spec.mounts, "/work/repo/.git/config")).toBeUndefined();
    expect(spec.requiredCopies).toEqual([
      { source: "/work/repo/.git/config", target: "/work/repo/.git/config" },
      {
        source: "/work/repo/.git/worktrees/wt/config.worktree",
        target: "/work/repo/.git/worktrees/wt/config.worktree",
      },
    ]);
    expect(spec.copiesDir).toBe(`/state/copies/${repoHash.slice(0, 12)}`);
  });

  it("needs no git mounts or copies outside git", () => {
    const workspace = { cwd: "/work/plain", repoRoot: "/work/plain", isGitRepo: false };
    const spec = buildContainerSpec(specInput({ workspace }));

    expect(spec.mounts.filter((mount) => mount.target.includes(".git"))).toEqual([]);
    expect(spec.requiredCopies).toEqual([]);
  });

  it("adds the extra read-only mounts from config at the same path", () => {
    const config = sandboxConfig({
      mounts: { extraReadOnly: ["/opt/shared", "vendor/sdk"], cacheVolumes: [] },
    });
    const mounts = buildContainerSpec(specInput({ config })).mounts;

    expect(mountAt(mounts, "/opt/shared")).toEqual({
      source: "/opt/shared",
      target: "/opt/shared",
      readOnly: true,
      kind: "bind",
    });
    expect(mountAt(mounts, "/work/repo/vendor/sdk")?.readOnly).toBe(true);
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
    expect(Object.keys(spec.env).filter((name) => name.endsWith("_PROXY"))).toEqual([]);
    expect(spec.labels["pi-sandbox.proxy-policy-hash"]).toBeUndefined();
  });

  it("holds only the proxy and static sandbox settings, no forwarded terminal variables", () => {
    expect(buildContainerSpec(specInput()).env).toEqual({
      HTTPS_PROXY: "http://pi-sandbox:token-1@10.89.0.2:3128",
      HTTP_PROXY: "http://pi-sandbox:token-1@10.89.0.2:3128",
      ALL_PROXY: "http://pi-sandbox:token-1@10.89.0.2:3128",
      NO_PROXY: "",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: "/etc/pi-sandbox/ca.pem",
      SSL_CERT_FILE: "/tmp/pi-sandbox/ca-bundle.pem",
      REQUESTS_CA_BUNDLE: "/tmp/pi-sandbox/ca-bundle.pem",
      GIT_SSL_CAINFO: "/tmp/pi-sandbox/ca-bundle.pem",
      PI_OFFLINE: "1",
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

  it("asks for the ssh agent only when ssh.agent is on and the backend can forward it", () => {
    const on = sandboxConfig({ ssh: { agent: true } });

    expect(buildContainerSpec(specInput()).sshAgent).toBeUndefined();
    expect(buildContainerSpec(specInput({ config: on })).sshAgent).toEqual({
      guestSocket: "/run/host-ssh-agent.sock",
    });
    expect(
      buildContainerSpec(specInput({ config: on, capabilities: { ...capabilities, sshAgent: false } }))
        .sshAgent,
    ).toBeUndefined();
    expect(buildContainerSpec(specInput({ config: on })).env.SSH_AUTH_SOCK).toBeUndefined();
  });

  it("maps the host user on linux only", () => {
    expect(buildContainerSpec(specInput({ platform: "linux" })).user).toBe("501:20");
    expect(buildContainerSpec(specInput()).user).toBeUndefined();
  });

  it("works in the repo root and carries the configured resources", () => {
    const config = sandboxConfig({ resources: { cpus: 4, memoryGiB: 8 } });
    const spec = buildContainerSpec(specInput({ config }));

    expect(spec.workdir).toBe(repoRoot);
    expect(spec.resources).toEqual({ cpus: 4, memoryGiB: 8 });
  });
});
