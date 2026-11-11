import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CredentialRule } from "../../config/index.ts";
import { createDialer } from "../../proxy/dial.ts";
import { createStateDir, removeDir, resolveTo, startTestProxy, type TestProxy } from "./harness.ts";
import { openConnect, readRest } from "./proxy-client.ts";

const ADDRESSES = {
  "gateway.corp.test": "10.1.2.3",
  "loopback.corp.test": "127.0.0.1",
  "metadata.corp.test": "169.254.169.254",
  "listed.corp.test": "10.1.2.4",
  "stale.corp.test": "10.1.2.5",
};

const RULE_HOSTS = ["gateway.corp.test", "loopback.corp.test", "metadata.corp.test", "listed.corp.test"];

const RULES: CredentialRule[] = RULE_HOSTS.map((host) => ({
  id: host,
  host,
  placeholder: "pi-sandbox-0123456789abcdef01234567",
  secret: { env: "KEY" },
}));

const state: { test?: TestProxy; stateDir: string } = { stateDir: "" };

const connectTo = async (authority: string) => {
  const reply = await openConnect(state.test?.proxy.port ?? 0, authority, state.test?.token);

  if (reply.status === 200) {
    reply.socket.destroy();

    return { status: reply.status };
  }

  const body = JSON.parse(await readRest(reply.socket)) as { rule: string; reason: string };

  return { status: reply.status, rule: body.rule, reason: body.reason };
};

describe("derived private network hosts", () => {
  beforeAll(async () => {
    state.stateDir = await createStateDir();
    state.test = await startTestProxy({
      stateDir: state.stateDir,
      policy: { allow: [] },
      rules: RULES,
      derivedHosts: ["stale.corp.test"],
      derivedPrivateHosts: [
        "gateway.corp.test",
        "loopback.corp.test",
        "metadata.corp.test",
        "stale.corp.test",
      ],
      dial: createDialer({ resolve: resolveTo(ADDRESSES) }),
    });
  });

  afterAll(async () => {
    await state.test?.proxy.close();

    await removeDir(state.stateDir);
  });

  it("lets a derived host that resolves to a private network address through", async () => {
    expect(await connectTo("gateway.corp.test:443")).toEqual({ status: 200 });
  });

  it.each([
    ["loopback.corp.test", "127.0.0.1 is a loopback address"],
    ["metadata.corp.test", "169.254.169.254 is a cloud metadata address"],
  ])("still refuses %s, which resolves to %s", async (host, range) => {
    expect(await connectTo(`${host}:443`)).toMatchObject({
      status: 403,
      reason: `${host} resolves only to restricted addresses (${range})`,
    });
  });

  it("refuses a rule host that is not a derived private host", async () => {
    expect(await connectTo("listed.corp.test:443")).toMatchObject({ status: 403, rule: "private-address" });
  });

  it("refuses a derived private host the running proxy holds no credential rule for", async () => {
    expect(await connectTo("stale.corp.test:443")).toMatchObject({ status: 403, rule: "private-address" });
  });
});
