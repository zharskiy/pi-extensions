import { Readable, Writable } from "node:stream";
import type { CredentialRule } from "../../config/index.ts";
import { type CheckResult, failed, type ProbeTarget, passed, skipped } from "../../container/index.ts";

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

const DEFAULT_TLS_PORT = 443;

const DENIED = [401, 403];

const TRUST_ERROR = /CERT|SELF_SIGNED|UNABLE_TO|ISSUER/;

const collector = () => {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write: (chunk: Buffer | string, _encoding, done) => {
      chunks.push(Buffer.from(chunk));

      done();
    },
  });

  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
};

const execText = async (target: ProbeTarget, command: string[]) => {
  const stdout = collector();
  const stderr = collector();
  const exitCode = await target.backend.exec(
    { containerId: target.containerId, command, env: {}, workdir: target.workdir },
    { stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream, tty: false },
  );

  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
};

const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .at(-1);

export const checkOffline = async (target: ProbeTarget) => {
  const { exitCode, stdout } = await execText(target, ["printenv", "PI_OFFLINE"]);

  return exitCode === 0 && stdout.trim() !== ""
    ? failed("PI_OFFLINE is set in the container, so package installs and updates are off")
    : passed("PI_OFFLINE is unset");
};

export const checkMcp = async (target: ProbeTarget) => {
  const { exitCode, stdout, stderr } = await execText(target, ["pi", "mcp", "list"]);

  if (exitCode === 0) {
    return passed("pi mcp list connects to every enabled server");
  }

  const detail = lastLine(stderr) ?? lastLine(stdout) ?? "no output";

  return failed(`pi mcp list exited ${exitCode}: ${detail}`);
};

const urlOf = (rule: CredentialRule) => {
  const port = rule.port === undefined || rule.port === DEFAULT_TLS_PORT ? "" : `:${rule.port}`;

  return `https://${rule.host}${port}${rule.pathPrefix ?? "/"}`;
};

const headerOf = (rule: CredentialRule) => {
  if (rule.placeholder === undefined) {
    return [];
  }

  if (rule.header === undefined) {
    return ["authorization", `Bearer ${rule.placeholder}`];
  }

  return [rule.header, rule.template?.replace("{secret}", rule.placeholder) ?? rule.placeholder];
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
