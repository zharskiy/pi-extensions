export const FIXTURE_HOSTS = {
  llm: "llm.fixtures.test",
  mcp: "mcp.fixtures.test",
  oauthMcp: "mcp-oauth.fixtures.test",
  auth: "auth.fixtures.test",
  tools: "tools.fixtures.test",
  page: "page.fixtures.test",
  git: "git.fixtures.test",
} as const;

export const LOOPBACK = "127.0.0.1";

export const ALL_FIXTURE_HOSTS: string[] = Object.values(FIXTURE_HOSTS);

export const resolveValue = (hosts: string[] = ALL_FIXTURE_HOSTS) =>
  hosts.map((host) => `${host}=${LOOPBACK}`).join(",");
