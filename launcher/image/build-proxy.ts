import { VM_HOST_ALIAS } from "../backend/index.ts";
import type { ParentProxy } from "../config/index.ts";
import { LauncherError } from "../shared/index.ts";

type Env = Record<string, string | undefined>;

const credentialsRefused = () =>
  new LauncherError(
    "image: the parent proxy needs credentials, and an image build cannot use them without writing them into the build",
    "build on a network that needs no proxy credentials, or set image.reference and image.digest to a prebuilt image",
  );

const hasUserInfo = (url: string) => {
  try {
    const parsed = new URL(url);

    return parsed.username !== "" || parsed.password !== "";
  } catch {
    throw new LauncherError("image: the parent proxy URL is not a valid URL");
  }
};

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];

const reachableFromBuild = (url: string | undefined) => {
  if (url === undefined || url === "" || !URL.canParse(url)) {
    return url;
  }

  const parsed = new URL(url);

  if (!LOOPBACK_HOSTS.includes(parsed.hostname)) {
    return url;
  }

  parsed.hostname = VM_HOST_ALIAS;

  return url.endsWith("/") ? parsed.href : parsed.href.replace(/\/$/, "");
};

const proxyArgs = (http: string | undefined, https: string | undefined, noProxy: string | undefined) => {
  const urls = [http, https].filter((url): url is string => url !== undefined && url !== "");

  if (urls.some(hasUserInfo)) {
    throw credentialsRefused();
  }

  const entries = [
    ["HTTP_PROXY", reachableFromBuild(http)],
    ["http_proxy", reachableFromBuild(http)],
    ["HTTPS_PROXY", reachableFromBuild(https)],
    ["https_proxy", reachableFromBuild(https)],
    ["NO_PROXY", noProxy],
    ["no_proxy", noProxy],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "");

  return Object.fromEntries(entries);
};

const envProxyArgs = (env: Env) => {
  const https = env.HTTPS_PROXY ?? env.https_proxy;
  const http = env.HTTP_PROXY ?? env.http_proxy ?? https;

  return proxyArgs(http, https ?? http, env.NO_PROXY ?? env.no_proxy);
};

export const buildProxyArgs = (parentProxy: ParentProxy, env: Env): Record<string, string> =>
  parentProxy === "none" ? {} : envProxyArgs(env);
