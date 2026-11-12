export { createColimaBackend } from "./colima/backend.ts";
export { ENGINE_PROFILE, VM_HOST_ALIAS } from "./colima/profile.ts";
export { shareDrift, shareText } from "./colima/shares.ts";
export { engineUnreachable, recommendedVmSize } from "./colima/vm.ts";
export { ExecTimeoutError, execCapture } from "./exec-capture.ts";
export { LABELS } from "./labels.ts";
export { relayName, repoNetworkName } from "./managed-network.ts";
export type {
  Backend,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  ExecIo,
  ExecSpec,
  ImageInfo,
  ImageSummary,
  MountSpec,
  NetworkRef,
  ProxyRouteRequest,
  TerminalSize,
  Vm,
  VmPath,
  VmShare,
  VmSize,
  VolumeSummary,
} from "./types.ts";
