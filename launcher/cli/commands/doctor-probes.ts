import { posix } from "node:path";
import { type Backend, execCapture } from "../../backend/index.ts";
import { type CredentialRule, fillTemplate, TLS_PORT } from "../../config/index.ts";
import { credentialHosts, probeHostSessions, readVolumeFile } from "../../provision/index.ts";
import { GUEST_PATHS, isAuthLikeHeader, isPlaceholder, isSecretName } from "../../shared/index.ts";
import { type CheckResult, failed, type NamedCheck, passed, skipped } from "./doctor-checks.ts";

export interface ProbeTarget {
  backend: Backend;
  containerId: string;
  workdir: string;
}

interface Leaf {
  path: string;
  value: string;
}

interface RuleAnswer {
  rule: CredentialRule;
  status?: number;
  body?: string;
  error?: string;
}

const GUEST_AUTH_FILE = posix.join(GUEST_PATHS.agentDir, "auth.json");

const GUEST_MCP_FILE = posix.join(GUEST_PATHS.agentDir, "mcp.json");

const TOKEN_FIELDS = ["access", "refresh"];

const ROUTE_TARGET = "1.1.1.1:443";

const NO_ROUTE_PROBE = [
  "sh",
  "-c",
  [
    "if command -v nc >/dev/null 2>&1; then exec nc -w 3 1.1.1.1 443 </dev/null; fi",
    "if command -v socat >/dev/null 2>&1; then exec socat -u OPEN:/dev/null TCP:1.1.1.1:443,connect-timeout=3; fi",
    "exit 127",
  ].join("; "),
];

const COMMAND_MISSING = 127;

const RULE_TIMEOUT_MS = 15_000;

const FETCH_SCRIPT = [
  "const [url, name, value] = process.argv.slice(1);",
  `const signal = AbortSignal.timeout(${RULE_TIMEOUT_MS});`,
  "fetch(url, { headers: name ? { [name]: value } : {}, redirect: 'manual', signal }).then(",
  "  async (response) => console.log(response.status === 502 ? '502 ' + (await response.text()).replace(/\\s+/g, ' ') : String(response.status)),",
  `  (error) => console.log('error ' + (error?.name === 'TimeoutError' ? 'no answer within ${RULE_TIMEOUT_MS / 1000} s' : String(error?.cause?.code ?? error?.code ?? error?.message))),`,
  ");",
].join("\n");

const DENIED = [401, 403];

const BAD_GATEWAY = 502;

const TRUST_ERROR = /CERT|SELF_SIGNED|UNABLE_TO|ISSUER/;

const NOT_YET_VALID = "CERT_NOT_YET_VALID";

const CLOCK_BEHIND = {
  reasons: [
    "the sandbox VM's clock is more than an hour behind the host's, so the proxy's certificate, dated by the host an hour back, is not valid there yet",
  ],
  hint: "restart the VM to reset its clock: run pi sandbox stop once no pi session runs, then pi sandbox doctor again",
};

const SECRET_TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"];

const MCP_LIST_SECONDS = 30;

const MCP_LIST_PROBE = ["timeout", String(MCP_LIST_SECONDS), "pi", "mcp", "list"];

const TIMED_OUT = 124;

const execText = (target: ProbeTarget, command: string[]) =>
  execCapture(target.backend, {
    containerId: target.containerId,
    command,
    env: {},
    workdir: target.workdir,
  });

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

const stringLeaves = (value: unknown, path: string): Leaf[] => {
  if (typeof value === "string") {
    return [{ path, value }];
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    stringLeaves(child, path === "" ? key : `${path}.${key}`),
  );
};

const parsedJson = (output: string) => {
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
};

const lastSegment = (path: string) => path.split(".").at(-1) ?? "";

const isPlaceholderValue = (value: string) =>
  value === "" || isPlaceholder(value) || isPlaceholder(value.trim().split(/\s+/).at(-1) ?? "");

const isSecretField = (path: string) => {
  const name = lastSegment(path);

  return name !== "type" && (TOKEN_FIELDS.includes(name) || isSecretName(name));
};

const foreignAuthPaths = (auth: unknown) =>
  stringLeaves(auth, "")
    .filter((leaf) => isSecretField(leaf.path) && !isPlaceholderValue(leaf.value))
    .map((leaf) => leaf.path);

const isMcpSecret = (path: string) => {
  const parts = path.split(".");
  const section = parts.at(-2);
  const name = parts.at(-1) ?? "";

  return (section === "headers" && isAuthLikeHeader(name)) || (section === "env" && isSecretName(name));
};

const foreignMcpPaths = (mcp: unknown) =>
  stringLeaves(mcp, "")
    .filter((leaf) => isMcpSecret(leaf.path) && !isPlaceholderValue(leaf.value))
    .map((leaf) => leaf.path);

const secretEnvNames = (output: string, proxyToken: string | undefined) =>
  output
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => ({ name: line.slice(0, line.indexOf("=")), value: line.slice(line.indexOf("=") + 1) }))
    .filter(({ name, value }) => isSecretName(name) && !isPlaceholderValue(value) && value !== proxyToken)
    .map(({ name }) => name);

const readGuestJson = async (target: ProbeTarget, path: string) => {
  const file = await execText(target, ["cat", path]);

  return file.code === 0 ? parsedJson(file.stdout) : {};
};

export const sweepCredentials = async (target: ProbeTarget, proxyToken?: string) => {
  const [env, auth, mcp] = await Promise.all([
    execText(target, ["env"]),
    readGuestJson(target, GUEST_AUTH_FILE),
    readGuestJson(target, GUEST_MCP_FILE),
  ]);
  const problems = [
    ...(env.code === 0 ? [] : [`env exited ${env.code}`]),
    ...(auth === undefined ? [`${GUEST_AUTH_FILE} is not JSON`] : []),
    ...(mcp === undefined ? [`${GUEST_MCP_FILE} is not JSON`] : []),
    ...secretEnvNames(env.stdout, proxyToken).map(
      (name) => `environment variable ${name} holds a value other than the placeholder`,
    ),
    ...foreignAuthPaths(auth).map(
      (path) => `${GUEST_AUTH_FILE} holds a value other than the placeholder at ${path}`,
    ),
    ...foreignMcpPaths(mcp).map(
      (path) => `${GUEST_MCP_FILE} holds a value other than a placeholder at ${path}`,
    ),
  ];

  return problems.length === 0
    ? passed("no credential in the environment, auth.json or mcp.json")
    : failed(
        `${problems.length} finding${problems.length === 1 ? "" : "s"} in the environment, auth.json or mcp.json`,
        { reasons: problems },
      );
};

export const checkNoRoute = async (target: ProbeTarget) => {
  const { code } = await execText(target, NO_ROUTE_PROBE);

  if (code === COMMAND_MISSING) {
    return failed("neither nc nor socat is in the image");
  }

  return code === 0
    ? failed(`${ROUTE_TARGET} is reachable directly`)
    : passed(`no direct route to ${ROUTE_TARGET}`);
};

export const checkMcp = async (target: ProbeTarget) => {
  const { code, stdout, stderr } = await execText(target, MCP_LIST_PROBE);

  if (code === 0) {
    return passed("pi mcp list connects to every enabled server");
  }

  if (code === TIMED_OUT) {
    return failed(`pi mcp list did not finish in ${MCP_LIST_SECONDS} s`);
  }

  const detail = lastLine(stderr) ?? lastLine(stdout) ?? "no output";

  return failed(`pi mcp list exited ${code}: ${detail}`);
};

const leaksToken = (entry: unknown) => {
  const tokens = (entry as { tokens?: Record<string, unknown> } | null)?.tokens;

  return SECRET_TOKEN_FIELDS.some((field) => {
    const value = tokens?.[field];

    return typeof value === "string" && !isPlaceholder(value);
  });
};

export const checkMcpAuthSweep = async (target: ProbeTarget) => {
  const { value: store, invalid } = await readVolumeFile(target.backend, target.containerId, "mcp-auth.json");

  if (invalid) {
    return failed("mcp-auth.json in the sandbox is not a JSON object");
  }

  if (store === undefined) {
    return passed("no mcp-auth.json in the sandbox yet");
  }

  const leaked = Object.keys(store).filter((key) => leaksToken(store[key]));

  return leaked.length === 0
    ? passed(`${Object.keys(store).length} entries in mcp-auth.json, every token is a placeholder`)
    : failed(`mcp-auth.json holds a token that is not a placeholder (${leaked.join(", ")})`);
};

export const checkSettingsSweep = async (target: ProbeTarget) => {
  const { value, invalid } = await readVolumeFile(target.backend, target.containerId, "settings.json");

  if (value === undefined && !invalid) {
    return passed("no settings.json in the sandbox yet");
  }

  const [host] = credentialHosts(value?.packages);

  return host === undefined
    ? passed("no settings.json package carries a credential in its URL")
    : failed(`settings.json package ${host} carries a credential in its URL`);
};

const urlOf = (rule: CredentialRule) => {
  const port = rule.port === undefined || rule.port === TLS_PORT ? "" : `:${rule.port}`;

  return `https://${rule.host}${port}${rule.pathPrefix ?? "/"}`;
};

const headerOf = (rule: CredentialRule) => {
  if (rule.placeholder === undefined) {
    return [];
  }

  if (rule.header === undefined) {
    return ["authorization", `Bearer ${rule.placeholder}`];
  }

  return [rule.header, fillTemplate(rule.template, rule.placeholder)];
};

const askRule = async (target: ProbeTarget, rule: CredentialRule): Promise<RuleAnswer> => {
  const { stdout } = await execText(target, ["node", "-e", FETCH_SCRIPT, urlOf(rule), ...headerOf(rule)]);
  const answer = lastLine(stdout) ?? "error no output";

  if (answer.startsWith("error ")) {
    return { rule, error: answer.slice("error ".length) };
  }

  const [status = "", ...body] = answer.split(" ");

  return { rule, status: Number(status), body: body.join(" ") };
};

const gatewayReason = (body: string | undefined) => {
  try {
    const parsed = JSON.parse(body ?? "") as { error?: unknown };

    return typeof parsed.error === "string" ? parsed.error : body;
  } catch {
    return body === undefined || body === "" ? "no reason given" : body;
  }
};

export interface RuleHint {
  unresolved?: CheckResult;
  refused?: CheckResult;
}

const fetchFailure = (subject: string, error: string | undefined) =>
  failed(`${subject}: ${error ?? "no answer"}`, error === NOT_YET_VALID ? CLOCK_BEHIND : {});

const ruleResult = (answer: RuleAnswer, hint: RuleHint) => {
  if (answer.status === undefined) {
    return hint.refused === undefined
      ? fetchFailure(urlOf(answer.rule), answer.error)
      : failed(`${urlOf(answer.rule)}: the sandbox proxy refused it`, {
          reasons: [hint.refused.detail],
          hint: hint.refused.hint,
        });
  }

  if (hint.unresolved !== undefined) {
    return hint.unresolved;
  }

  if (answer.status === BAD_GATEWAY) {
    return failed(`${urlOf(answer.rule)} answered HTTP 502`, {
      reasons: [gatewayReason(answer.body) ?? "no reason given"],
    });
  }

  return DENIED.includes(answer.status)
    ? failed(`${urlOf(answer.rule)} answered HTTP ${answer.status} with the placeholder`)
    : passed(`${urlOf(answer.rule)} answered HTTP ${answer.status}`);
};

const trustResult = (answers: RuleAnswer[]) => {
  if (answers.length === 0) {
    return skipped("no credential rule, nothing is terminated");
  }

  const broken = answers.find((answer) => answer.error !== undefined && TRUST_ERROR.test(answer.error));

  if (broken !== undefined) {
    return fetchFailure(broken.rule.host, broken.error);
  }

  const verified = answers.find((answer) => answer.status !== undefined);

  return verified === undefined
    ? failed("no rule host answered, so the chain could not be checked")
    : passed(`the container trusts the proxy's certificate for ${verified.rule.host}`);
};

export const checkRules = async (
  target: ProbeTarget,
  rules: CredentialRule[],
  ruleHints: () => Promise<ReadonlyMap<string, RuleHint>> = async () => new Map(),
): Promise<NamedCheck[]> => {
  const answers = await Promise.all(rules.map((rule) => askRule(target, rule)));
  const hints = await ruleHints();

  return [
    { name: "trust", section: "credentials", result: trustResult(answers) },
    ...answers.map(
      (answer): NamedCheck => ({
        name: `rule ${answer.rule.id}`,
        section: "credentials",
        group: "rules",
        result: ruleResult(answer, hints.get(answer.rule.id) ?? {}),
      }),
    ),
  ];
};

export const checkSessionsShare = async (target: ProbeTarget, sessionDir: string | undefined) => {
  if (sessionDir === undefined || !posix.isAbsolute(sessionDir)) {
    return skipped(`in the sandbox volume${sessionDir === undefined ? "" : ` (${sessionDir})`}`);
  }

  return (await probeHostSessions(target.backend, target.containerId, sessionDir))
    ? passed("writable at the host path")
    : failed(`${sessionDir} is not writable from the sandbox`, {
        hint: "set sessions.host: false or share it with the VM",
      });
};
