import { describe, expect, it } from "vitest";
import { isLauncherSetVariable } from "../../shared/index.ts";

describe("isLauncherSetVariable", () => {
  it.each([
    "PI_CODING_AGENT_DIR",
    "BASH_ENV",
    "HTTPS_PROXY",
    "https_proxy",
    "Https_Proxy",
    "no_proxy",
    "ALL_PROXY",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "PINATA",
    "PINATA_AWAIT_HANDOVER",
    "PINATA_LAUNCH_ID",
    "PINATA_STATUS",
    "PI_SELF_UPDATE_COMMAND",
    "GITLAB_HOST",
    "HOME",
    "PATH",
    "PWD",
  ])("is true for %s", (name) => {
    expect(isLauncherSetVariable(name)).toBe(true);
  });

  it.each([
    "TERM",
    "LANG",
    "COLORTERM",
    "EDITOR",
    "path",
    "ssl_cert_file",
    "PINATA_TRUST_HASH",
    "JAVA_TOOL_OPTIONS",
    "PINATA_PROXY_TOKEN",
    "PINATA_PROXY_HOST",
    "PINATA_PROXY_PORT",
  ])("is false for %s", (name) => {
    expect(isLauncherSetVariable(name)).toBe(false);
  });
});
