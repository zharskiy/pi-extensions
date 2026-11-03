export { createDockerEngineBackend } from "./docker-engine/backend.ts";
export { resolveDockerSocket } from "./docker-engine/socket.ts";
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
  TerminalSize,
} from "./types.ts";
