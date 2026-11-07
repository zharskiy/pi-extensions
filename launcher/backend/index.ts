export { createAppleBackend } from "./apple/backend.ts";
export { createDockerEngineBackend } from "./docker-engine/backend.ts";
export { resolveDockerSocket } from "./docker-engine/socket.ts";
export { execCapture } from "./exec-capture.ts";
export { LABELS } from "./labels.ts";
export { createDefaultAdapters, selectBackend } from "./select.ts";
export type {
  Backend,
  BackendCapabilities,
  BackendName,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  ExecIo,
  ExecSpec,
  ImageInfo,
  MountSpec,
  NetworkRef,
  ProxyRoute,
  ProxyRouteRequest,
  TerminalSize,
} from "./types.ts";
