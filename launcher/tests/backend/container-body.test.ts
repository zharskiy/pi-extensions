import { describe, expect, it } from "vitest";
import { containerBody, inspectOf } from "../../backend/colima/container-body.ts";
import type { ContainerSpec } from "../../backend/index.ts";

const AGENT: ContainerSpec = {
  name: "pinata-abc",
  image: "pinata-base:local",
  labels: { "pinata.managed": "true", "pinata.role": "agent" },
  mounts: [
    { kind: "bind", source: "/repo", target: "/repo", readOnly: false },
    { kind: "volume", source: "vol", target: "/home/pi", readOnly: false },
  ],
  network: { kind: "internal", name: "pinata-net-abc" },
  env: { HOME: "/home/pi", A: "b=c" },
  workdir: "/repo",
  readOnlyRoot: true,
  tmpfs: ["/tmp:mode=1777,exec", "/run"],
  init: true,
  resources: { cpus: 1.5, memoryGiB: 2, pids: 4096, openFiles: 1024, shmMiB: 64 },
  capabilities: ["CHOWN"],
  autoRemove: true,
};

const AGENT_BODY =
  '{"Image":"pinata-base:local","Labels":{"pinata.managed":"true","pinata.role":"agent"},' +
  '"Env":["HOME=/home/pi","A=b=c"],"WorkingDir":"/repo","HostConfig":{"Mounts":[' +
  '{"Type":"bind","Source":"/repo","Target":"/repo","ReadOnly":false},' +
  '{"Type":"volume","Source":"vol","Target":"/home/pi","ReadOnly":false}],' +
  '"NetworkMode":"pinata-net-abc","ReadonlyRootfs":true,"Tmpfs":{"/tmp":"mode=1777,exec","/run":""},' +
  '"Init":true,"AutoRemove":true,"CapDrop":["ALL"],"CapAdd":["CHOWN"],"SecurityOpt":["no-new-privileges"],' +
  '"PidsLimit":4096,"Ulimits":[{"Name":"nofile","Soft":1024,"Hard":1024}],' +
  '"NanoCpus":1500000000,"Memory":2147483648,"ShmSize":67108864}}';

describe("container body", () => {
  it("sends the agent's body byte for byte as before the optional fields existed", () => {
    expect(JSON.stringify(containerBody(AGENT))).toBe(AGENT_BODY);
  });

  it("gives a container its alias on the internal network it joins at creation", () => {
    const body = containerBody({
      ...AGENT,
      network: { kind: "internal", name: "pinata-net", alias: "pinata-services" },
    });

    expect(body.HostConfig.NetworkMode).toBe("pinata-net");
    expect(body).toMatchObject({
      NetworkingConfig: { EndpointsConfig: { "pinata-net": { Aliases: ["pinata-services"] } } },
    });
    expect(containerBody(AGENT)).not.toHaveProperty("NetworkingConfig");
  });

  it("joins another container's network as the user and command it names, kept after it exits", () => {
    const body = containerBody({
      ...AGENT,
      labels: {},
      mounts: [],
      env: {},
      workdir: undefined,
      network: { kind: "container", id: "pod-id" },
      tmpfs: ["/tmp:mode=1777,exec"],
      resources: { pids: 4096 },
      user: "1000:1000",
      entrypoint: ["sh", "-c"],
      command: ["exec server"],
      capabilities: [],
      autoRemove: false,
    });

    expect(body).toEqual({
      Image: "pinata-base:local",
      User: "1000:1000",
      Labels: {},
      Env: [],
      Entrypoint: ["sh", "-c"],
      Cmd: ["exec server"],
      HostConfig: {
        Mounts: [],
        NetworkMode: "container:pod-id",
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "mode=1777,exec" },
        Init: true,
        AutoRemove: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 4096,
      },
    });
  });
});

describe("container inspect", () => {
  it("keeps the exit code the engine reports, and none when it reports none", () => {
    expect(inspectOf({ Id: "a", State: { Status: "exited", ExitCode: 0 } })).toEqual({
      id: "a",
      labels: {},
      state: "stopped",
      exitCode: 0,
    });
    expect(inspectOf({ Id: "a", State: { Status: "exited" } })).toEqual({
      id: "a",
      labels: {},
      state: "stopped",
    });
  });

  it("keeps the labels the engine reports", () => {
    expect(inspectOf({ Id: "a", Config: { Labels: { role: "agent" } } }).labels).toEqual({ role: "agent" });
  });
});
