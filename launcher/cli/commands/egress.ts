import { authorityOf, matchesDenyEntry, parseEntry, parseHostEntry, TLS_PORT } from "../../config/index.ts";
import { activeGrants, addGrant, type Grant, readGrants, revokeGrants } from "../../grants/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { assertSafeMounts } from "../../workspace/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { usageOf } from "./help.ts";
import { assertOptions } from "./options.ts";

interface Target {
  host: string;
  port: number;
}

const USER_FLAG = "--user";

const DENIED_FLAG = "--denied";

const HELP_FLAGS = ["-h", "--help"];

const GRANTS_OFF = "grants are turned off by egress.grants";

const usage = (problem: string) => new LauncherError(problem, usageOf("egress"));

const isFlag = (arg: string) => arg.startsWith("-");

const parseTarget = (text: string | undefined): Target => {
  const entry = parseHostEntry((text ?? "").trim(), { wildcard: false, port: true });

  if ("problem" in entry) {
    throw usage(`egress: ${text ?? "(none)"} ${entry.problem}`);
  }

  return { host: entry.pattern, port: entry.port ?? TLS_PORT };
};

const targetArgs = (command: string, args: string[]) => {
  const flags = args.filter(isFlag);
  const [text, ...extra] = args.filter((arg) => !isFlag(arg));

  assertOptions(command, flags, [USER_FLAG]);

  if (extra.length > 0) {
    throw usage(`${command}: takes one host, got ${[text, ...extra].join(" ")}`);
  }

  return { text, target: parseTarget(text), user: flags.includes(USER_FLAG) };
};

const scopeText = (grant: Grant) => (grant.repoHash === undefined ? "every repository" : "this repository");

const grantText = (grant: Grant) => `${authorityOf(grant.host, grant.port)} for ${scopeText(grant)}`;

const assertNotDenied = (context: LaunchContext, target: Target) => {
  const entry = context.effective.config.egress.deny.find((text) => {
    const { pattern, port } = parseEntry(text);

    return matchesDenyEntry(target.host, pattern) && (port ?? target.port) === target.port;
  });

  if (entry !== undefined) {
    throw new LauncherError(
      `egress: ${authorityOf(target.host, target.port)} is denied by the egress.deny entry ${entry}, which a grant cannot override`,
      "pi sandbox config shows the layers that set egress.deny",
    );
  }
};

const allow = async (deps: CliDeps, args: string[]) => {
  const { target, user } = targetArgs("egress allow", args);
  const { context } = await openContext(deps, "host");

  if (!user) {
    assertSafeMounts([context.workspace.repoRoot], { home: deps.home, env: deps.env });
  }

  assertNotDenied(context, target);

  const grant = await addGrant(
    context.stateDir,
    { ...target, ...(user ? {} : { repoHash: context.repoHash }) },
    context.effective.config.egress.grants,
    deps.now(),
  );
  const scope = user ? "every repository" : context.workspace.repoRoot;

  writeLine(deps.stdout, `allowed ${authorityOf(grant.host, grant.port)} for ${scope}`);

  return 0;
};

const otherScopeHolds = async (
  context: LaunchContext,
  target: Target,
  port: number | undefined,
  user: boolean,
) =>
  (await readGrants(context.stateDir)).some(
    (grant) =>
      grant.host === target.host &&
      (port === undefined || grant.port === port) &&
      grant.repoHash === (user ? context.repoHash : undefined),
  );

const revoke = async (deps: CliDeps, args: string[]) => {
  const { text, target, user } = targetArgs("egress revoke", args);
  const { context } = await openContext(deps, "host");
  const port = text?.includes(":") ? target.port : undefined;
  const count = await revokeGrants(context.stateDir, {
    host: target.host,
    ...(port === undefined ? {} : { port }),
    ...(user ? {} : { repoHash: context.repoHash }),
  });

  if (count === 0 && (await otherScopeHolds(context, target, port, user))) {
    throw new LauncherError(
      `egress: ${text} has no grant for ${user ? "every repository" : "this repository"}; its grant is for ${user ? "this repository" : "every repository"}`,
      `pi sandbox egress revoke ${text}${user ? "" : ` ${USER_FLAG}`}`,
    );
  }

  writeLine(deps.stdout, `revoked ${count} grant${count === 1 ? "" : "s"} for ${text}`);

  return 0;
};

export const grantLines = async (context: LaunchContext) =>
  activeGrants(await readGrants(context.stateDir), context.repoHash).map(grantText);

const deniedLines = async (deps: CliDeps, context: LaunchContext) => {
  const denials = await deps.proxy.denials(context.stateDir, context.repoHash, 0);

  return denials.map(
    (denial) =>
      `denied ${authorityOf(denial.host, denial.port)} at ${new Date(denial.time).toISOString()}: ${denial.reason}`,
  );
};

const listedGrants = async (context: LaunchContext) => {
  if (!context.effective.config.egress.grants) {
    return [GRANTS_OFF];
  }

  const lines = await grantLines(context);

  return lines.length === 0 ? ["no active grants"] : lines;
};

const listedDenials = async (deps: CliDeps, context: LaunchContext) => {
  const lines = await deniedLines(deps, context);

  return lines.length === 0 ? ["no denials recorded by the running proxy"] : lines;
};

const list = async (deps: CliDeps, args: string[]) => {
  assertOptions("egress list", args, [DENIED_FLAG]);

  const { context } = await openContext(deps, "host");
  const lines = args.includes(DENIED_FLAG) ? await listedDenials(deps, context) : await listedGrants(context);

  writeLines(deps.stdout, lines);

  return 0;
};

const ACTIONS: Record<string, (deps: CliDeps, args: string[]) => Promise<number>> = { allow, revoke, list };

export const egressCommand = (deps: CliDeps, args: string[]) => {
  const [action = "", ...rest] = args;

  if (HELP_FLAGS.includes(action)) {
    writeLine(deps.stdout, `usage: ${usageOf("egress")}`);

    return Promise.resolve(0);
  }

  const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;

  if (run === undefined) {
    throw usage(`unknown egress action "${action}"`);
  }

  if (rest.some((arg) => HELP_FLAGS.includes(arg))) {
    writeLine(deps.stdout, `usage: ${usageOf(`egress ${action}`)}`);

    return Promise.resolve(0);
  }

  return run(deps, rest);
};
