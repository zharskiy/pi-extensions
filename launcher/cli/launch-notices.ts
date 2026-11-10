import { basename } from "node:path";
import { overlayVolumes } from "../container/index.ts";
import type { SandboxImage } from "../image/index.ts";
import { workspaceNotices } from "../workspace/index.ts";
import type { LaunchContext } from "./context.ts";
import type { HostSide } from "./derive.ts";
import type { SandboxProxy } from "./sandbox-proxy.ts";

const CAPPED_NOTICE =
  "pi-sandbox: more than 512 build output directories; overlays disabled, the host copies are used";

const overlayNotices = (context: LaunchContext) => {
  if (context.workspace.overlaysCapped === true) {
    return [CAPPED_NOTICE];
  }

  const paths = overlayVolumes(context.workspace, context.effective.config).map((overlay) => overlay.path);

  if (paths.length === 0) {
    return [];
  }

  const places = paths.length === 1 ? "1 directory" : `${paths.length} directories`;
  const kinds = [...new Set(paths.map((path) => basename(path)))].sort().join(", ");

  return [
    `pi-sandbox: ${kinds} overlaid in ${places}; the host copies are hidden; set mounts.autoOverlays=false to keep them`,
  ];
};

const hostCacheNotices = (context: LaunchContext) => {
  const presets = [...new Set(context.effective.config.mounts.hostCaches)];

  return presets.length === 0
    ? []
    : [
        `pi-sandbox: host caches shared read-write with the sandbox: ${presets.join(", ")}; host builds run what the sandbox writes there`,
      ];
};

const isPinned = (context: LaunchContext) => context.effective.config.image.digest !== undefined;

const imagePiNotices = (context: LaunchContext, host: HostSide, image: SandboxImage) =>
  host.pi === undefined || isPinned(context) || image.pi === host.pi.version
    ? []
    : [
        `pi-sandbox: the sandbox image has pi ${image.pi ?? "of an unrecorded version"}, the host pi ${host.pi.version}; the image is rebuilt after every session in this repository exits`,
      ];

export const launchNotices = (context: LaunchContext, host: HostSide, image: SandboxImage) => [
  ...imagePiNotices(context, host, image),
  ...workspaceNotices(context.workspace),
  ...overlayNotices(context),
  ...hostCacheNotices(context),
];

export const proxyDetail = (proxy: SandboxProxy | undefined) =>
  proxy === undefined
    ? "not required, no credential rule and an empty allowlist"
    : `pid ${proxy.proxy.pid} port ${proxy.proxy.port}`;
