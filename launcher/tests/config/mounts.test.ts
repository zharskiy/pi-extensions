import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/defaults.ts";
import { loadEffectiveConfig } from "../../config/index.ts";
import { configProblem, validateConfig } from "../../config/validate.ts";
import { createConfigFile } from "./fixtures.ts";

const volumesProblem = (volumes: unknown) => configProblem({ mounts: { volumes } });

const bindsProblem = (binds: unknown) => configProblem({ mounts: { binds } });

const loadWith = async (config?: unknown) => {
  const file = await createConfigFile();

  if (config !== undefined) {
    await file.write(config);
  }

  return loadEffectiveConfig({ env: file.env });
};

describe("mounts.volumes", () => {
  it("defaults to no volumes, no binds and node_modules overlays on", async () => {
    const { config, sources } = await loadWith();

    expect(defaultConfig().mounts).toEqual({ volumes: [], binds: [], autoOverlays: true });
    expect(config.mounts).toMatchObject({ volumes: [], binds: [], autoOverlays: true });
    expect(sources["mounts.volumes"]).toBe("default");
  });

  it("accepts home paths, absolute paths outside the home and entries with a name", () => {
    expect(
      volumesProblem([
        "~/.cache/pip",
        "~/.npm/",
        "/opt/data",
        "/var/lib/db",
        "/var/lib/app/data",
        "/var/log/db",
        "/data",
        "/logs",
        "/srv/x",
        "/etc/app/conf.d",
        "/libexec",
        "/tmp/x",
        "/tmp/pi-sandbox-readyx",
        { target: "~/.gradle" },
        { target: "/srv/cache", name: "shared-cache" },
      ]),
    ).toBeUndefined();
  });

  it.each([
    ["~", "config: mounts.volumes[0] ~ must be an absolute path or start with ~/"],
    ["rel/dir", "config: mounts.volumes[0] rel/dir must be an absolute path or start with ~/"],
    ["~/a/../b", "config: mounts.volumes[0] ~/a/../b must not hold empty, . or .. segments"],
    ["~/a//b", "config: mounts.volumes[0] ~/a//b must not hold empty, . or .. segments"],
    ["/opt/./a", "config: mounts.volumes[0] /opt/./a must not hold empty, . or .. segments"],
    ["~/.pi/agent", "config: mounts.volumes[0] ~/.pi/agent must not be or lie under ~/.pi"],
    ["~/.config/gh", "config: mounts.volumes[0] ~/.config/gh must not be or lie under ~/.config"],
    ["~/.ssh", "config: mounts.volumes[0] ~/.ssh must not be or lie under ~/.ssh"],
    [
      "~/.local/bin/tool",
      "config: mounts.volumes[0] ~/.local/bin/tool must not be or lie under ~/.local/bin",
    ],
    ["/home/pi/.npm", "config: mounts.volumes[0] /home/pi/.npm lies in /home/pi; write it as ~/.npm"],
    ["/", "config: mounts.volumes[0] / overlaps /usr, which the sandbox needs"],
    ["/usr", "config: mounts.volumes[0] /usr overlaps /usr, which the sandbox needs"],
    ["/usr/local/lib", "config: mounts.volumes[0] /usr/local/lib overlaps /usr, which the sandbox needs"],
    ["/usr/bin", "config: mounts.volumes[0] /usr/bin overlaps /usr, which the sandbox needs"],
    ["/bin", "config: mounts.volumes[0] /bin overlaps /bin, which the sandbox needs"],
    ["/sbin/x", "config: mounts.volumes[0] /sbin/x overlaps /sbin, which the sandbox needs"],
    ["/lib", "config: mounts.volumes[0] /lib overlaps /lib, which the sandbox needs"],
    ["/lib64", "config: mounts.volumes[0] /lib64 overlaps /lib64, which the sandbox needs"],
    ["/root", "config: mounts.volumes[0] /root overlaps /root, which the sandbox needs"],
    ["/proc", "config: mounts.volumes[0] /proc overlaps /proc, which the sandbox needs"],
    ["/sys/fs", "config: mounts.volumes[0] /sys/fs overlaps /sys, which the sandbox needs"],
    ["/dev/shm", "config: mounts.volumes[0] /dev/shm overlaps /dev, which the sandbox needs"],
    ["/run/x", "config: mounts.volumes[0] /run/x overlaps /run, which the sandbox needs"],
    ["/var", "config: mounts.volumes[0] /var overlaps /var/run, which the sandbox needs"],
    ["/var/run/nscd", "config: mounts.volumes[0] /var/run/nscd overlaps /var/run, which the sandbox needs"],
    ["/opt", "config: mounts.volumes[0] /opt overlaps /opt/pi-sandbox, which the sandbox needs"],
    [
      "/opt/pi-sandbox",
      "config: mounts.volumes[0] /opt/pi-sandbox overlaps /opt/pi-sandbox, which the sandbox needs",
    ],
    ["/etc", "config: mounts.volumes[0] /etc overlaps /etc/ssl, which the sandbox needs"],
    ["/etc/ssl/certs", "config: mounts.volumes[0] /etc/ssl/certs overlaps /etc/ssl, which the sandbox needs"],
    [
      "/etc/ld.so.preload",
      "config: mounts.volumes[0] /etc/ld.so.preload overlaps /etc/ld.so.preload, which the sandbox needs",
    ],
    [
      "/etc/ld.so.conf.d",
      "config: mounts.volumes[0] /etc/ld.so.conf.d overlaps /etc/ld.so.conf.d, which the sandbox needs",
    ],
    ["/etc/passwd", "config: mounts.volumes[0] /etc/passwd overlaps /etc/passwd, which the sandbox needs"],
    [
      "/etc/nsswitch.conf",
      "config: mounts.volumes[0] /etc/nsswitch.conf overlaps /etc/nsswitch.conf, which the sandbox needs",
    ],
    ["/home", "config: mounts.volumes[0] /home overlaps /home/pi, which the sandbox needs"],
    ["/tmp", "config: mounts.volumes[0] /tmp overlaps /tmp, which the sandbox needs"],
    [
      "/tmp/pi-sandbox-handover",
      "config: mounts.volumes[0] /tmp/pi-sandbox-handover overlaps /tmp/pi-sandbox-handover, which the sandbox needs",
    ],
    [
      "/tmp/pi-sandbox-ready/x",
      "config: mounts.volumes[0] /tmp/pi-sandbox-ready/x overlaps /tmp/pi-sandbox-ready, which the sandbox needs",
    ],
  ])("refuses the target %s", (target, message) => {
    expect(volumesProblem([target])).toBe(message);
  });

  it("refuses a scope, a bad name and an entry without a target", () => {
    expect(volumesProblem([{ target: "/opt/a", scope: "repo" }])).toBe(
      "config: mounts.volumes[0].scope is not a known key",
    );
    expect(volumesProblem([{ target: "/opt/a", name: "Big Name" }])).toBe(
      "config: mounts.volumes[0].name must be lowercase letters, digits, dot, dash or underscore",
    );
    expect(volumesProblem([{ name: "data" }])).toBe("config: mounts.volumes[0].target is required");
  });

  it("refuses the same target twice, also when one entry has a trailing slash", () => {
    expect(volumesProblem(["~/.npm", { target: "~/.npm/" }])).toBe(
      "config: mounts lists the target /home/pi/.npm twice",
    );
  });

  it("refuses a target nested in another one", () => {
    expect(volumesProblem(["~/.cache/pip", "~/.cache"])).toBe(
      "config: mounts lists the target /home/pi/.cache/pip inside another target",
    );
  });

  it("refuses one name twice", () => {
    expect(
      volumesProblem([
        { target: "/opt/a", name: "data" },
        { target: "/opt/b", name: "data" },
      ]),
    ).toBe("config: mounts.volumes names the volume data twice");
  });

  it("takes the volumes from the config and drops a trailing slash", async () => {
    const { config, sources } = await loadWith({
      mounts: { volumes: ["~/.npm/", { target: "/opt/data/" }] },
    });

    expect(config.mounts.volumes).toEqual(["~/.npm", { target: "/opt/data" }]);
    expect(sources["mounts.volumes"]).toBe("config");
  });
});

describe("mounts.binds", () => {
  it("accepts a host source and a container target", () => {
    expect(
      bindsProblem([
        { source: "~/tools/conf", target: "/etc/tool" },
        { source: "/Volumes/data/ref", target: "~/ref" },
        { source: "/Volumes/data/conf", target: "/etc/app/conf.d" },
        { source: "/Volumes/data/opt", target: "/opt/tool" },
        { source: "/Volumes/data/state", target: "/var/lib/app/state" },
      ]),
    ).toBeUndefined();
  });

  it("needs both a source and a target", () => {
    expect(bindsProblem([{ target: "/etc/tool" }])).toBe("config: mounts.binds[0].source is required");
    expect(bindsProblem([{ source: "/data" }])).toBe("config: mounts.binds[0].target is required");
  });

  it("refuses a relative source and a target the sandbox needs", () => {
    expect(bindsProblem([{ source: "data", target: "/etc/tool" }])).toBe(
      "config: mounts.binds[0].source data must be an absolute path or start with ~/",
    );
    expect(bindsProblem([{ source: "/data", target: "/usr/local/bin" }])).toBe(
      "config: mounts.binds[0].target /usr/local/bin overlaps /usr, which the sandbox needs",
    );
    expect(bindsProblem([{ source: "/data", target: "/etc/ld.so.preload" }])).toBe(
      "config: mounts.binds[0].target /etc/ld.so.preload overlaps /etc/ld.so.preload, which the sandbox needs",
    );
    expect(bindsProblem([{ source: "/data", target: "/tmp/pi-sandbox-ready" }])).toBe(
      "config: mounts.binds[0].target /tmp/pi-sandbox-ready overlaps /tmp/pi-sandbox-ready, which the sandbox needs",
    );
  });

  it("refuses a bind target inside a volume target", () => {
    expect(
      configProblem({
        mounts: { volumes: ["/opt/data"], binds: [{ source: "/data", target: "/opt/data/ref" }] },
      }),
    ).toBe("config: mounts lists the target /opt/data/ref inside another target");
  });
});

describe("setup", () => {
  it("defaults to no commands and takes argument lists", async () => {
    expect(defaultConfig().setup).toEqual([]);

    const { config, sources } = await loadWith({
      setup: [
        ["npm", "ci"],
        ["sh", "-c", "make init"],
      ],
    });

    expect(config.setup).toEqual([
      ["npm", "ci"],
      ["sh", "-c", "make init"],
    ]);
    expect(sources.setup).toBe("config");
  });

  it("refuses an empty command, a blank command name and a string in place of a list", () => {
    expect(configProblem({ setup: [[]] })).toBe("config: setup[0] must not be empty");
    expect(configProblem({ setup: [[" ", "x"]] })).toBe("config: setup[0] must name a command first");
    expect(configProblem({ setup: ["npm ci"] })).toBe("config: setup[0] must be an array");
  });
});

describe("mounts.autoOverlays", () => {
  it("is taken from the config", async () => {
    const { config, sources } = await loadWith({ mounts: { autoOverlays: false } });

    expect(config.mounts.autoOverlays).toBe(false);
    expect(sources["mounts.autoOverlays"]).toBe("config");
  });

  it("must be true or false", () => {
    expect(() => validateConfig({ mounts: { autoOverlays: "off" } })).toThrow(
      "config: mounts.autoOverlays must be true or false",
    );
  });
});
