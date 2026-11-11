import { VM_HOST_ALIAS } from "../backend/index.ts";
import { type ParentProxy, parentProxyOf } from "../config/index.ts";
import { LauncherError } from "../shared/index.ts";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

const credentialsRefused = () =>
  new LauncherError(
    "image: the parent proxy needs credentials, and an image build cannot use them without writing them into the build",
    "build on a network that needs no proxy credentials; a prebuilt image (image.reference and image.digest) avoids the build only when image.packages, image.npmGlobal and image.dockerfile are unset",
  );

const urlHost = (host: string) => {
  const reachable = LOOPBACK_HOSTS.includes(host) ? VM_HOST_ALIAS : host;

  return reachable.includes(":") ? `[${reachable}]` : reachable;
};

export const buildProxyArgs = (
  parentProxy: ParentProxy,
  env: Record<string, string | undefined>,
): Record<string, string> => {
  const target = parentProxyOf(parentProxy, env);

  if (target === undefined || "unsupported" in target) {
    return {};
  }

  if (target.hasCredentials) {
    throw credentialsRefused();
  }

  const url = `http://${urlHost(target.host)}:${target.port}`;
  const noProxy = target.noProxy.join(",");

  return {
    HTTP_PROXY: url,
    http_proxy: url,
    HTTPS_PROXY: url,
    https_proxy: url,
    ...(noProxy === "" ? {} : { NO_PROXY: noProxy, no_proxy: noProxy }),
  };
};
