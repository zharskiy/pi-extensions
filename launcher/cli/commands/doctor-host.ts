import { connect } from "node:net";
import { join } from "node:path";
import type { ParentProxy } from "../../config/index.ts";
import { failed, passed, skipped } from "../../container/index.ts";
import { readJsonFile, stateLayout } from "../../shared/index.ts";
import type { CliDeps } from "../deps.ts";
import { providerHostsOf } from "../derive.ts";
import type { LaunchContext } from "../launch.ts";
import { piVersion } from "../versions.ts";
import type { NamedCheck } from "./doctor-container.ts";
import { grantLines } from "./egress.ts";

interface OrgMeta {
  fetchedAt?: number;
  sha256?: string;
}

const CONNECT_TIMEOUT_MS = 3000;

const HOUR_MS = 3_600_000;

const SHORT_HASH = 12;

const DEFAULT_PROXY_PORT = 80;

const checkBundledPi = async (deps: CliDeps) => {
  const bundled = await deps.bundledPi();

  if (bundled === undefined) {
    return failed("no pi next to the launcher; reinstall it with npm install -g pi-extensions-mz");
  }

  const pinned = await piVersion();

  return bundled.version === pinned
    ? passed(`pi ${bundled.version}, the same as the image`)
    : failed(`the launcher's pi ${bundled.version} differs from the image pi ${pinned}`);
};

const checkProviderHosts = async (deps: CliDeps, context: LaunchContext) => {
  const { hosts, notices } = await providerHostsOf(deps, context.stateDir);
  const count = Object.keys(hosts).length;

  return count > 0
    ? passed(`${count} built-in providers with known hosts`)
    : failed(notices[0] ?? "the provider host table is empty");
};

const parentUrl = (parent: ParentProxy, env: NodeJS.ProcessEnv) => {
  if (parent === "none") {
    return undefined;
  }

  return parent === "env" ? (env.HTTPS_PROXY ?? env.https_proxy) : parent.url;
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

const parsedUrl = (text: string) => {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
};

const checkParentProxy = async (deps: CliDeps, context: LaunchContext) => {
  const text = parentUrl(context.effective.config.egress.parentProxy, deps.env);

  if (text === undefined || text === "") {
    return skipped("no parent proxy configured");
  }

  const url = parsedUrl(text);

  if (url === undefined) {
    return failed("the parent proxy URL does not parse");
  }

  const authority = `${url.hostname}:${url.port || DEFAULT_PROXY_PORT}`;

  return (await reachable(url.hostname, Number(url.port || DEFAULT_PROXY_PORT)))
    ? passed(`${authority} accepts connections`)
    : failed(`${authority} does not accept connections`);
};

const displaySource = (source: string) => {
  const url = parsedUrl(source);

  return url === undefined || url.protocol !== "https:" ? source : `${url.origin}${url.pathname}`;
};

const checkOrg = async (deps: CliDeps, context: LaunchContext) => {
  const ref = context.effective.config.org;

  if (ref === undefined) {
    return skipped("no org baseline configured");
  }

  const meta = await readJsonFile<OrgMeta>(join(stateLayout(context.stateDir).org, "meta.json")).catch(
    () => undefined,
  );

  if (meta?.fetchedAt === undefined || meta.sha256 === undefined) {
    return failed(`${displaySource(ref.source)} has not been fetched`);
  }

  if (ref.sha256 !== undefined && ref.sha256 !== meta.sha256) {
    return failed(`${displaySource(ref.source)}: the cached copy does not match the pinned sha256`);
  }

  const hours = Math.floor((deps.now() - meta.fetchedAt) / HOUR_MS);

  return passed(
    `${displaySource(ref.source)} fetched ${hours} h ago, sha256 ${meta.sha256.slice(0, SHORT_HASH)}`,
  );
};

const checkGrants = async (deps: CliDeps, context: LaunchContext) => {
  if (!context.effective.config.egress.grants.enabled) {
    return passed("turned off by egress.grants.enabled");
  }

  const lines = await grantLines(deps, context);

  return passed(lines.length === 0 ? "none active" : `${lines.length} active: ${lines.join("; ")}`);
};

export const hostChecks = async (deps: CliDeps, context: LaunchContext): Promise<NamedCheck[]> => [
  { name: "bundled pi", result: await checkBundledPi(deps) },
  { name: "provider hosts", result: await checkProviderHosts(deps, context) },
  { name: "parent proxy", result: await checkParentProxy(deps, context) },
  { name: "org baseline", result: await checkOrg(deps, context) },
  { name: "grants", result: await checkGrants(deps, context) },
];
