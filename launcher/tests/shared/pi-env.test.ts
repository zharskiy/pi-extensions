import { describe, expect, it } from "vitest";
import { isLauncherSetVariable } from "../../shared/index.ts";

describe("isLauncherSetVariable", () => {
  it.each([
    "PI_CODING_AGENT_DIR",
    "BASH_ENV",
    "JAVA_TOOL_OPTIONS",
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
    "PI_SANDBOX",
    "PI_SANDBOX_TRUST_HASH",
    "GITLAB_HOST",
    "HOME",
    "PATH",
    "PWD",
  ])("is true for %s", (name) => {
    expect(isLauncherSetVariable(name)).toBe(true);
  });

  it.each(["TERM", "LANG", "COLORTERM", "EDITOR", "path", "ssl_cert_file"])("is false for %s", (name) => {
    expect(isLauncherSetVariable(name)).toBe(false);
  });
});
