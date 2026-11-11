import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { connect } from "node:net";
import { parentProxyOf } from "../../config/index.ts";
import {
  type HostPi,
  type HostPiFiles,
  type McpSignIn,
  mcpSignIns,
  readHostPiFiles,
} from "../../hostpi/index.ts";
import { errorMessage, isFreshMcpToken } from "../../shared/index.ts";
import { assertHostSessionsDir } from "../../workspace/index.ts";
import type { LaunchContext } from "../context.ts";
import { type CliDeps, hostAgentDirOf } from "../deps.ts";
import { providerHostsOf } from "../derive.ts";
import { hostPiPlace, hostPiText, missingPiText, resolveJobPi } from "../host-pi.ts";
import { hostSessionsOf } from "../host-sessions.ts";
import { leftoverStateNotice, movedConfigNotice } from "../legacy-paths.ts";
import { isOlderVersion, testedPiVersion } from "../versions.ts";
import { failed, type NamedCheck, passed, skipped, warned } from "./doctor-probes.ts";

const CONNECT_TIMEOUT_MS = 3000;

const MINUTE_MS = 60_000;

const HOUR_MS = 3_600_000;

const DAY_MS = 86_400_000;

const MINUTES_SHOWN_BELOW_MS = 2 * HOUR_MS;

const HOURS_SHOWN_BELOW_MS = 2 * DAY_MS;

const checkHostPi = async (deps: CliDeps, context: LaunchContext, job: HostPi | undefined) => {
  if (job === undefined) {
    return failed(missingPiText(deps));
  }

  const tested = await testedPiVersion();

  if (isOlderVersion(job.version, tested)) {
    return warned(
      `pi ${job.version} (${hostPiPlace(job)}) is older than ${tested}, the pi this launcher is tested with; run pi update`,
    );
  }

  const image =
    context.effective.config.image.digest === undefined
      ? "the image follows it"
      : "the image is pinned by image.digest";

  return passed(`${hostPiText(job)}; ${image}`);
};

const checkProviderHosts = async (deps: CliDeps, context: LaunchContext, pi: HostPi | undefined) => {
  if (pi === undefined) {
    return failed("no host pi to read the provider host table with");
  }

  const { hosts, notices } = await providerHostsOf(deps, context, pi);
  const count = Object.keys(hosts).length;

  return count > 0
    ? passed(`${count} built-in providers with known hosts`)
    : failed(notices[0] ?? "the provider host table is empty");
};

const reachable = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });

    socket.once("connect", () => {
      socket.destroy();

      resolve(true);
    });

    socket.once("timeout", () => {
      socket.destroy();

      resolve(false);
    });

    socket.once("error", () => resolve(false));
  });

const checkParentProxy = async (deps: CliDeps, context: LaunchContext) => {
  const target = parentProxyOf(context.effective.config.egress.parentProxy, deps.env);

  if (target === undefined) {
    return skipped("no parent proxy configured");
  }

  if ("unsupported" in target) {
    return failed(target.unsupported);
  }

  const authority = target.host.includes(":")
    ? `[${target.host}]:${target.port}`
    : `${target.host}:${target.port}`;

  return (await reachable(target.host, target.port))
    ? passed(`${authority} accepts connections`)
    : failed(`${authority} does not accept connections`);
};

const durationText = (ms: number) => {
  if (ms < MINUTES_SHOWN_BELOW_MS) {
    return `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
  }

  return ms < HOURS_SHOWN_BELOW_MS ? `${Math.round(ms / HOUR_MS)} h` : `${Math.round(ms / DAY_MS)} days`;
};

const signInCheck = (deps: CliDeps, server: McpSignIn): NamedCheck => {
  const name = `mcp ${server.name}`;
  const { entry } = server;
  const usable = isFreshMcpToken(entry, deps.now()) || entry?.refresh !== undefined;

  if (!usable) {
    return { name, result: warned(`needs sign-in: run pi mcp login ${server.name}`) };
  }

  const left = entry?.expiresAt === undefined ? undefined : entry.expiresAt - deps.now();

  if (left === undefined) {
    return { name, result: passed("signed in on the host") };
  }

  return {
    name,
    result: passed(
      left > 0
        ? `signed in on the host (expires in ${durationText(left)})`
        : "signed in on the host (refreshed on use)",
    ),
  };
};

const signInChecks = async (deps: CliDeps, files: HostPiFiles): Promise<NamedCheck[]> =>
  (await mcpSignIns(files)).map((server) => signInCheck(deps, server));

const unsafeSessionsDir = (deps: CliDeps, context: LaunchContext, dir: string) => {
  try {
    assertHostSessionsDir(dir, {
      home: deps.home,
      agentDir: hostAgentDirOf(deps),
      repoRoot: context.workspace.repoRoot,
    });

    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
};

const checkSessions = async (deps: CliDeps, context: LaunchContext, files: HostPiFiles) => {
  const sessions = hostSessionsOf(deps, context, files.settings);

  if ("off" in sessions) {
    return skipped(`in the sandbox volume (${sessions.off})`);
  }

  if ((await lstat(sessions.dir).catch(() => undefined)) === undefined) {
    return passed(`${sessions.dir} (host pi lists them, created at the first launch)`);
  }

  const unsafe = unsafeSessionsDir(deps, context, sessions.dir);

  if (unsafe !== undefined) {
    return failed(unsafe);
  }

  const writable = await access(sessions.dir, constants.W_OK).then(
    () => true,
    () => false,
  );

  return writable
    ? passed(`${sessions.dir} (host pi lists them)`)
    : failed(`${sessions.dir} is not writable`);
};

const legacyChecks = async (deps: CliDeps): Promise<NamedCheck[]> => {
  const [config, state] = await Promise.all([movedConfigNotice(deps), leftoverStateNotice(deps)]);

  return [
    ...config.map((notice) => ({ name: "user config", result: warned(notice) })),
    ...state.map((notice) => ({ name: "old state", result: warned(notice) })),
  ];
};

const named = async (name: string, result: Promise<NamedCheck["result"]>): Promise<NamedCheck> => ({
  name,
  result: await result,
});

export const hostChecks = async (deps: CliDeps, context: LaunchContext): Promise<NamedCheck[]> => {
  const [files, pi] = await Promise.all([readHostPiFiles(hostAgentDirOf(deps)), resolveJobPi(deps)]);
  const [legacy, checks, signIns] = await Promise.all([
    legacyChecks(deps),
    Promise.all([
      named("host pi", checkHostPi(deps, context, pi)),
      named("provider hosts", checkProviderHosts(deps, context, pi)),
      named("parent proxy", checkParentProxy(deps, context)),
      named("sessions", checkSessions(deps, context, files)),
    ]),
    signInChecks(deps, files),
  ]);

  return [...legacy, ...checks, ...signIns];
};
