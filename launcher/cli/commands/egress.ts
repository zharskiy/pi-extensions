import { authorityOf, matchesDenyEntry, parseEntry, parseHostEntry, TLS_PORT } from "../../config/index.ts";
import { addGrant, type Grant, readGrants, revokeGrants } from "../../grants/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type LaunchContext, openContext } from "../context.ts";
import { type CliDeps, writeLines } from "../deps.ts";
import { stepsOf } from "../steps.ts";
import { usageOf } from "./help.ts";
import { assertOptions } from "./options.ts";

interface Target {
  host: string;
  port: number;
}

const DENIED_FLAG = "--denied";

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

  assertOptions(command, flags, []);

  if (extra.length > 0) {
    throw usage(`${command}: takes one host, got ${[text, ...extra].join(" ")}`);
  }

  return { text, target: parseTarget(text) };
};

const grantText = (grant: Grant) => authorityOf(grant.host, grant.port);

const assertNotDenied = (context: LaunchContext, target: Target) => {
  const entry = context.effective.config.egress.deny.find((text) => {
    const { pattern, port } = parseEntry(text);

    return matchesDenyEntry(target.host, pattern) && (port ?? target.port) === target.port;
  });

  if (entry !== undefined) {
    throw new LauncherError(
      `egress: ${authorityOf(target.host, target.port)} is denied by the egress.deny entry ${entry}, which a grant cannot override`,
      "pinata config shows the layers that set egress.deny",
    );
  }
};

const allow = async (deps: CliDeps, args: string[]) => {
  const { target } = targetArgs("egress allow", args);
  const { context } = await openContext(deps, "host");

  assertNotDenied(context, target);

  const grant = await addGrant(context.stateDir, target, deps.now());

  stepsOf(deps).done(`Allowed ${grantText(grant)}`);

  return 0;
};

const revoke = async (deps: CliDeps, args: string[]) => {
  const { text, target } = targetArgs("egress revoke", args);
  const { context } = await openContext(deps, "host");
  const port = text?.includes(":") ? target.port : undefined;
  const count = await revokeGrants(context.stateDir, {
    host: target.host,
    ...(port === undefined ? {} : { port }),
  });

  if (count === 0) {
    stepsOf(deps).note(`No grant for ${text}.`);

    return 0;
  }

  stepsOf(deps).done(`Revoked ${count} grant${count === 1 ? "" : "s"} for ${text}`);

  return 0;
};

export const grantLines = async (context: LaunchContext) =>
  (await readGrants(context.stateDir)).map(grantText);

const deniedLines = async (deps: CliDeps, context: LaunchContext) => {
  const denials = await deps.proxy.denials(context.stateDir, 0);

  return denials.map(
    (denial) =>
      `${authorityOf(denial.host, denial.port)} at ${new Date(denial.time).toISOString()}: ${denial.reason}`,
  );
};

const listedGrants = async (context: LaunchContext) => {
  const lines = await grantLines(context);

  return lines.length === 0 ? ["No grants."] : lines;
};

const listedDenials = async (deps: CliDeps, context: LaunchContext) => {
  const lines = await deniedLines(deps, context);

  return lines.length === 0 ? ["No host blocked since the proxy started."] : lines;
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

  const run = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;

  if (run === undefined) {
    throw usage(`unknown egress action "${action}"`);
  }

  return run(deps, rest);
};
