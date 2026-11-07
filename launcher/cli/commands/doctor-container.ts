import { posix } from "node:path";
import { execCapture } from "../../backend/index.ts";
import { type CredentialRule, fillTemplate, TLS_PORT } from "../../config/index.ts";
import { type CheckResult, failed, type ProbeTarget, passed, skipped } from "../../container/index.ts";
import { sourceOfEntry, withoutSourceCredential } from "../../hostpi/index.ts";
import { probeHostSessions, readVolumeFile } from "../../provision/index.ts";
import { isPlaceholder } from "../../shared/index.ts";

export interface NamedCheck {
  name: string;
  result: CheckResult;
}

interface RuleAnswer {
  rule: CredentialRule;
  status?: number;
  error?: string;
}

const FETCH_SCRIPT = [
  "const [url, name, value] = process.argv.slice(1);",
  "fetch(url, { headers: name ? { [name]: value } : {}, redirect: 'manual' }).then(",
  "  (response) => console.log(String(response.status)),",
  "  (error) => console.log('error ' + String(error?.cause?.code ?? error?.code ?? error?.message)),",
  ");",
].join("\n");

const DENIED = [401, 403];

const TRUST_ERROR = /CERT|SELF_SIGNED|UNABLE_TO|ISSUER/;

const SECRET_TOKEN_FIELDS = ["access_token", "refresh_token", "id_token"];

export const OFFLINE_PROBE = ["printenv", "PI_OFFLINE"];

export const MCP_LIST_PROBE = ["pi", "mcp", "list"];

export const SHIM_PROBE = ["xdg-open", "--pi-sandbox-check"];

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

export const checkOffline = async (target: ProbeTarget) => {
  const { code, stdout } = await execText(target, OFFLINE_PROBE);

  return code === 0 && stdout.trim() !== ""
    ? failed("PI_OFFLINE is set in the container, so package installs and updates are off")
    : passed("PI_OFFLINE is unset");
};

export const checkMcp = async (target: ProbeTarget) => {
  const { code, stdout, stderr } = await execText(target, MCP_LIST_PROBE);

  if (code === 0) {
    return passed("pi mcp list connects to every enabled server");
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

const credentialHosts = (packages: unknown) =>
  (Array.isArray(packages) ? packages : []).flatMap((entry) => {
    const source = sourceOfEntry(entry);
    const stripped = source === undefined ? undefined : withoutSourceCredential(source);

    return stripped === undefined ? [] : [stripped.host];
  });

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

export const checkBrowserShim = async (target: ProbeTarget) => {
  const { code, stdout, stderr } = await execText(target, SHIM_PROBE);

  return code === 0
    ? passed("xdg-open reaches the proxy's /healthz")
    : failed(
        `xdg-open --pi-sandbox-check exited ${code}: ${lastLine(stderr) ?? lastLine(stdout) ?? "no output"}`,
      );
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

  return answer.startsWith("error ")
    ? { rule, error: answer.slice("error ".length) }
    : { rule, status: Number(answer) };
};

const ruleResult = (answer: RuleAnswer) => {
  if (answer.status === undefined) {
    return failed(`${urlOf(answer.rule)}: ${answer.error ?? "no answer"}`);
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
    return failed(`${broken.rule.host}: ${broken.error}`);
  }

  const verified = answers.find((answer) => answer.status !== undefined);

  return verified === undefined
    ? failed("no rule host answered, so the chain could not be checked")
    : passed(`the container trusts the proxy's certificate for ${verified.rule.host}`);
};

export const checkRules = async (target: ProbeTarget, rules: CredentialRule[]): Promise<NamedCheck[]> => {
  const answers = await Promise.all(rules.map((rule) => askRule(target, rule)));

  return [
    { name: "trust", result: trustResult(answers) },
    ...answers.map((answer) => ({ name: `rule ${answer.rule.id}`, result: ruleResult(answer) })),
  ];
};

export const checkSessionsShare = async (target: ProbeTarget, sessionDir: string | undefined) => {
  if (sessionDir === undefined || !posix.isAbsolute(sessionDir)) {
    return skipped(`in the sandbox volume${sessionDir === undefined ? "" : ` (${sessionDir})`}`);
  }

  return (await probeHostSessions(target.backend, target.containerId, sessionDir))
    ? passed("writable at the host path")
    : failed(
        `${sessionDir} is not writable from the sandbox; set sessions.host: false or share it with the VM`,
      );
};
