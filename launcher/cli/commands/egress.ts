import { authorityOf } from "../../config/index.ts";
import { activeGrants, addGrant, type Grant, readGrants, revokeGrants } from "../../grants/index.ts";
import { LauncherError } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { type LaunchContext, openContext } from "../launch.ts";

interface Target {
  host: string;
  port: number;
}

const USAGE =
  "pi sandbox egress allow <host[:port]> [--user] | revoke <host[:port]> [--user] | list [--user] [--denied]";

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const DEFAULT_PORT = 443;

const MAX_PORT = 65_535;

const usage = (problem: string) => new LauncherError(problem, USAGE);

const parseTarget = (text: string | undefined): Target => {
  const [host = "", port, ...extra] = (text ?? "").trim().toLowerCase().split(":");
  const number = port === undefined ? DEFAULT_PORT : Number(port);

  if (!HOST.test(host) || extra.length > 0 || !Number.isInteger(number) || number < 1 || number > MAX_PORT) {
    throw usage(`egress: ${text ?? "(none)"} is not a host or host:port`);
  }

  return { host, port: number };
};

const assertFlags = (flags: string[], known: string[]) => {
  const unknown = flags.find((flag) => !known.includes(flag));

  if (unknown !== undefined) {
    throw usage(`egress: unknown option ${unknown}`);
  }
};

const scopeText = (grant: Grant) => (grant.repoHash === undefined ? "every repository" : "this repository");

const grantText = (grant: Grant) => `${authorityOf(grant.host, grant.port)} for ${scopeText(grant)}`;

const allow = async (deps: CliDeps, args: string[]) => {
  const [text, ...flags] = args;

  assertFlags(flags, ["--user"]);

  const target = parseTarget(text);
  const { context } = await openContext(deps, "host");
  const grant = await addGrant(
    context.stateDir,
    { ...target, ...(flags.includes("--user") ? {} : { repoHash: context.repoHash }) },
    context.effective.config.egress.grants,
    deps.now(),
  );

  writeLine(deps.stdout, `allowed ${grantText(grant)}`);

  return 0;
};

const revoke = async (deps: CliDeps, args: string[]) => {
  const [text, ...flags] = args;

  assertFlags(flags, ["--user"]);

  const target = parseTarget(text);
  const { context } = await openContext(deps, "host");
  const count = await revokeGrants(context.stateDir, {
    host: target.host,
    ...(text?.includes(":") ? { port: target.port } : {}),
    ...(flags.includes("--user") ? {} : { repoHash: context.repoHash }),
  });

  writeLine(deps.stdout, `revoked ${count} grant${count === 1 ? "" : "s"} for ${text}`);

  return 0;
};

export const grantLines = async (context: LaunchContext, userOnly = false) =>
  activeGrants(await readGrants(context.stateDir), context.repoHash)
    .filter((grant) => !userOnly || grant.repoHash === undefined)
    .map(grantText);

const deniedLines = async (deps: CliDeps, context: LaunchContext) => {
  const denials = await deps.proxy.denials(context.stateDir, context.repoHash, 0);

  return denials.map(
    (denial) =>
      `denied ${authorityOf(denial.host, denial.port)} at ${new Date(denial.time).toISOString()}: ${denial.reason}`,
  );
};

const list = async (deps: CliDeps, args: string[]) => {
  assertFlags(args, ["--denied", "--user"]);

  const { context } = await openContext(deps, "host");
  const lines = args.includes("--denied")
    ? await deniedLines(deps, context)
    : await grantLines(context, args.includes("--user"));
  const empty = args.includes("--denied") ? "no denials recorded by the running proxy" : "no active grants";

  writeLines(deps.stdout, lines.length === 0 ? [empty] : lines);

  return 0;
};

export const egressCommand = (deps: CliDeps, args: string[]) => {
  const [action, ...rest] = args;

  if (action === "allow") {
    return allow(deps, rest);
  }

  if (action === "revoke") {
    return revoke(deps, rest);
  }

  if (action === "list") {
    return list(deps, rest);
  }

  throw usage(`unknown egress action "${action ?? ""}"`);
};
