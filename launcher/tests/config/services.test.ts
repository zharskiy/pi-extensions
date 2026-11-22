import { describe, expect, it } from "vitest";
import { validateConfig } from "../../config/validate.ts";

const service = (fields: Record<string, unknown> = {}) => ({
  name: "db",
  command: ["db", "--serve"],
  ...fields,
});

const problemOf = (config: unknown) => {
  try {
    validateConfig(config);

    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
};

describe("services config", () => {
  it("accepts a full entry and returns it unchanged", () => {
    const entry = service({
      image: "docker.io/library/postgres:17",
      user: "70:70",
      env: { POSTGRES_PASSWORD: "local" },
      volumes: [{ name: "pgdata", target: "/var/lib/postgresql/data" }],
      tmpfs: ["/run/postgresql"],
      ready: { command: ["pg_isready"], timeoutSeconds: 120 },
      memoryGiB: 2,
      shmMiB: 256,
    });

    expect(validateConfig({ services: [entry] })).toEqual({ services: [entry] });
  });

  it("requires a name and a command naming a command first", () => {
    expect(problemOf({ services: [{ command: ["x"] }] })).toBe("config: services[0].name is required");
    expect(problemOf({ services: [{ name: "db" }] })).toBe("config: services[0].command is required");
    expect(problemOf({ services: [service({ command: [] })] })).toBe(
      "config: services[0].command must not be empty",
    );
    expect(problemOf({ services: [service({ ready: { command: [" "] } })] })).toBe(
      "config: services[0].ready.command must name a command first",
    );
  });

  it("refuses a duplicate name", () => {
    expect(problemOf({ services: [service(), service()] })).toBe(
      "config: services names the service db twice",
    );
  });

  it("refuses root and non-numeric users", () => {
    expect(problemOf({ services: [service({ user: "0:0" })] })).toContain("services[0].user must be uid:gid");
    expect(problemOf({ services: [service({ user: "1000:0" })] })).toContain(
      "services[0].user must be uid:gid",
    );
    expect(problemOf({ services: [service({ user: "postgres" })] })).toContain(
      "services[0].user must be uid:gid",
    );
  });

  it("takes only absolute normalised paths other than / and names each refused one", () => {
    expect(problemOf({ services: [service({ tmpfs: ["/"] })] })).toBe(
      "config: services[0].tmpfs[0] / must be an absolute path other than /",
    );
    expect(problemOf({ services: [service({ tmpfs: ["/run/"] })] })).toContain("must be a normalised path");
    expect(problemOf({ services: [service({ volumes: [{ name: "d", target: "/a/../b" }] })] })).toBe(
      "config: services[0].volumes[0].target /a/../b must be a normalised path: no trailing slash and no empty, . or .. segments",
    );
  });

  it("keeps volume targets and tmpfs paths apart, /tmp included", () => {
    expect(problemOf({ services: [service({ tmpfs: ["/tmp"] })] })).toBe(
      "config: services[0] lists /tmp twice (/tmp is always a tmpfs)",
    );
    expect(problemOf({ services: [service({ volumes: [{ name: "d", target: "/tmp/data" }] })] })).toBe(
      "config: services[0] lists /tmp/data inside another volume target or tmpfs path",
    );
    expect(
      problemOf({ services: [service({ volumes: [{ name: "d", target: "/data" }], tmpfs: ["/data/run"] })] }),
    ).toBe("config: services[0] lists /data/run inside another volume target or tmpfs path");
  });

  it("does not apply the agent's reserved paths to a service", () => {
    expect(problemOf({ services: [service({ volumes: [{ name: "d", target: "/usr/local/data" }] })] })).toBe(
      undefined,
    );
  });

  it("refuses one volume mounted by two services as different users", () => {
    const volumes = [{ name: "shared", target: "/data" }];

    expect(
      problemOf({ services: [service({ volumes }), service({ name: "other", volumes, user: "70:70" })] }),
    ).toBe("config: services mounts the volume shared as two different users");
    expect(
      problemOf({ services: [service({ volumes }), service({ name: "other", volumes, user: "1000:1000" })] }),
    ).toBe(undefined);
  });

  it("runs every service that mounts a volume the agent shares as the agent's user", () => {
    const volumes = [{ name: "db-logs", target: "/logs" }];
    const config = (user?: string) => ({
      mounts: { volumes: [{ target: "/var/log/db", name: "db-logs" }] },
      services: [service({ volumes, ...(user === undefined ? {} : { user }) })],
    });

    expect(problemOf(config())).toBe(undefined);
    expect(problemOf(config("1000:1000"))).toBe(undefined);
    expect(problemOf(config("70:70"))).toBe(
      "config: services: mounts the volume db-logs as 70:70, but mounts.volumes shares it with the agent, so every service that mounts it runs as 1000:1000",
    );
  });

  it("takes ports from 1 to 65535 and refuses one port listed twice across the services", () => {
    expect(problemOf({ services: [service({ ports: [1, 5432, 65535] })] })).toBe(undefined);
    expect(problemOf({ services: [service({ ports: [] })] })).toBe(undefined);
    expect(problemOf({ services: [service({ ports: [0] })] })).toContain("services[0].ports[0]");
    expect(problemOf({ services: [service({ ports: [65536] })] })).toContain("services[0].ports[0]");
    expect(problemOf({ services: [service({ ports: [5.5] })] })).toContain("services[0].ports[0]");
    expect(problemOf({ services: [service({ ports: "5432" })] })).toContain("services[0].ports");
    expect(problemOf({ services: [service({ ports: [5432, 5432] })] })).toBe(
      "config: services lists the port 5432 twice",
    );
    expect(
      problemOf({ services: [service({ ports: [6379] }), service({ name: "cache", ports: [6379] })] }),
    ).toBe("config: services lists the port 6379 twice");
  });

  it("refuses : and , in service paths, which the engine reads as separators", () => {
    expect(problemOf({ services: [service({ tmpfs: ["/run/a,b"] })] })).toBe(
      "config: services[0].tmpfs[0] /run/a,b must not hold : or , (the container engine reads them as separators)",
    );
    expect(problemOf({ services: [service({ volumes: [{ name: "d", target: "/data:ro" }] })] })).toContain(
      "services[0].volumes[0].target /data:ro must not hold : or ,",
    );
  });

  it("caps the uid and gid at 2147483647", () => {
    expect(problemOf({ services: [service({ user: "2147483647:2147483647" })] })).toBe(undefined);
    expect(problemOf({ services: [service({ user: "2147483648:1" })] })).toBe(
      "config: services[0].user must be uid:gid, each at most 2147483647",
    );
    expect(problemOf({ services: [service({ user: "1:9999999999" })] })).toContain("each at most 2147483647");
  });

  it("bounds the ready timeout", () => {
    expect(problemOf({ services: [service({ ready: { command: ["x"], timeoutSeconds: 0 } })] })).toBe(
      "config: services[0].ready.timeoutSeconds must be at least 1",
    );
    expect(problemOf({ services: [service({ ready: { command: ["x"], timeoutSeconds: 3601 } })] })).toBe(
      "config: services[0].ready.timeoutSeconds must be at most 3600",
    );
  });

  it("counts the services' memory with the agent's against the VM", () => {
    const config = (agent: number | undefined) => ({
      vm: { memoryGiB: 8 },
      ...(agent === undefined ? {} : { resources: { memoryGiB: agent } }),
      services: [service({ memoryGiB: 2 }), service({ name: "cache", memoryGiB: 1.5 })],
    });

    expect(problemOf(config(4))).toBe(undefined);
    expect(problemOf(config(5))).toBe(
      "config: resources.memoryGiB 5 plus the services' memoryGiB 3.5 is larger than vm.memoryGiB 8; the agent and every service share the VM",
    );
    expect(problemOf({ ...config(undefined), vm: { memoryGiB: 3 } })).toBe(
      "config: resources.memoryGiB 0 plus the services' memoryGiB 3.5 is larger than vm.memoryGiB 3; the agent and every service share the VM",
    );
  });
});
