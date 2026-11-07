import {
  addGrant,
  type Grant,
  type GrantScope,
  liveSessions,
  readGrants,
  revokeGrants,
} from "../../grants/index.ts";
import { proxyPolicyHash } from "../../proxy/index.ts";
import { LauncherError, sha256Hex } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { type LaunchContext, openContext } from "../launch.ts";
import { authorityOf } from "../sandbox-proxy.ts";
import { liveLaunchIds } from "../sessions.ts";

interface Target {
  host: string;
  port: number;
}

interface AllowOptions {
  scope?: "session" | "hours" | "permanent";
  hours?: number;
  user: boolean;
}

const USAGE =
  "pi sandbox egress allow <host[:port]> [--session | --hours N | --permanent] [--user] | revoke <host[:port]> [--user] | list [--denied]";

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

const scopeFlag = (options: AllowOptions, scope: AllowOptions["scope"]) => {
  if (options.scope !== undefined) {
    throw usage("egress allow: pick one of --session, --hours N and --permanent");
  }

  return { ...options, scope };
};

const parseAllowFlags = (args: string[], options: AllowOptions = { user: false }): AllowOptions => {
  const [flag, ...rest] = args;

  if (flag === undefined) {
    return options;
  }

  if (flag === "--user") {
    return parseAllowFlags(rest, { ...options, user: true });
  }

  if (flag === "--session" || flag === "--permanent") {
    return parseAllowFlags(rest, scopeFlag(options, flag === "--session" ? "session" : "permanent"));
  }

  if (flag === "--hours") {
    const [hours, ...after] = rest;

    return parseAllowFlags(after, { ...scopeFlag(options, "hours"), hours: Number(hours) });
  }

  throw usage(`egress: unknown option ${flag}`);
};

const repoHashOf = (context: LaunchContext) => sha256Hex(context.workspace.repoRoot);

const sessionLaunch = async (deps: CliDeps, context: LaunchContext) => {
  const sessions = await liveSessions(context.stateDir, repoHashOf(context));
  const current = deps.env.PI_SANDBOX_LAUNCH_ID;

  if (current !== undefined && current !== "") {
    if (!sessions.some((entry) => entry.launchId === current)) {
      throw new LauncherError(
        `egress allow: launch ${current} is not a running pi session of this repository`,
      );
    }

    return current;
  }

  const newest = [...sessions].sort((left, right) => right.startedAt - left.startedAt)[0];

  if (newest === undefined) {
    throw new LauncherError(
      "egress allow --session: no pi session is running for this repository",
      "start pi first, or use --hours N or --permanent",
    );
  }

  return newest.launchId;
};

const scopeOf = async (deps: CliDeps, context: LaunchContext, options: AllowOptions): Promise<GrantScope> => {
  if (options.scope === "permanent") {
    return { kind: "permanent" };
  }

  if (options.scope === "hours") {
    return { kind: "hours", hours: options.hours ?? Number.NaN };
  }

  return { kind: "session", launchId: await sessionLaunch(deps, context) };
};

const until = (grant: Grant) =>
  grant.expiresAt === undefined ? "permanently" : `until ${new Date(grant.expiresAt).toISOString()}`;

const scopeText = (grant: Grant) => (grant.repoHash === undefined ? "every repository" : "this repository");

const lifetimeText = (grant: Grant) =>
  grant.launchId === undefined ? until(grant) : `for session ${grant.launchId}, ${until(grant)}`;

const allow = async (deps: CliDeps, args: string[]) => {
  const [text, ...flags] = args;
  const target = parseTarget(text);
  const options = parseAllowFlags(flags);
  const context = await openContext(deps);
  const grant = await addGrant(
    context.stateDir,
    {
      ...target,
      ...(options.user ? {} : { repoHash: repoHashOf(context) }),
      scope: await scopeOf(deps, context, options),
    },
    context.effective.config.egress.grants,
    deps.now(),
  );

  writeLine(
    deps.stdout,
    `allowed ${authorityOf(grant.host, grant.port)} for ${scopeText(grant)} ${lifetimeText(grant)}`,
  );

  return 0;
};

const revoke = async (deps: CliDeps, args: string[]) => {
  const [text, ...flags] = args;
  const unknown = flags.find((flag) => flag !== "--user");

  if (unknown !== undefined) {
    throw usage(`egress: unknown option ${unknown}`);
  }

  const target = parseTarget(text);
  const context = await openContext(deps);
  const count = await revokeGrants(context.stateDir, {
    host: target.host,
    ...(text?.includes(":") ? { port: target.port } : {}),
    ...(flags.includes("--user") ? {} : { repoHash: repoHashOf(context) }),
  });

  writeLine(deps.stdout, `revoked ${count} grant${count === 1 ? "" : "s"} for ${text}`);

  return 0;
};

const isShown = (grant: Grant, context: LaunchContext, now: number, live: ReadonlySet<string>) =>
  (grant.repoHash === undefined || grant.repoHash === repoHashOf(context)) &&
  (grant.expiresAt === undefined || grant.expiresAt > now) &&
  (grant.launchId === undefined || live.has(grant.launchId));

export const grantLines = async (deps: CliDeps, context: LaunchContext) => {
  const live = await liveLaunchIds(context.stateDir);
  const grants = (await readGrants(context.stateDir)).filter((grant) =>
    isShown(grant, context, deps.now(), live),
  );

  return grants.map(
    (grant) => `${authorityOf(grant.host, grant.port)} for ${scopeText(grant)} ${lifetimeText(grant)}`,
  );
};

const deniedLines = async (deps: CliDeps, context: LaunchContext) => {
  const policyHash = proxyPolicyHash(context.effective.config, context.effective.egressCap);
  const denials = await deps.proxy.denials(context.stateDir, policyHash, {
    repoHash: repoHashOf(context),
    since: 0,
  });

  return denials.map(
    (denial) =>
      `denied ${authorityOf(denial.host, denial.port)} at ${new Date(denial.time).toISOString()}: ${denial.reason}`,
  );
};

const list = async (deps: CliDeps, args: string[]) => {
  const unknown = args.find((arg) => arg !== "--denied");

  if (unknown !== undefined) {
    throw usage(`egress: unknown option ${unknown}`);
  }

  const context = await openContext(deps);
  const lines = args.includes("--denied")
    ? await deniedLines(deps, context)
    : await grantLines(deps, context);
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
