export { createColimaBackend } from "./colima/backend.ts";
export { ENGINE_PROFILE, sessionsRunning, shareText, VM_HOST_ALIAS } from "./colima/profile.ts";
export { engineUnreachable } from "./colima/vm.ts";
export { execCapture } from "./exec-capture.ts";
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
  VmApplied,
  VmDesired,
  VmInspect,
  VmPath,
  VmPhase,
  VmShare,
  VmSize,
  VmSpec,
  VmTarget,
  VolumeSummary,
} from "./types.ts";
export { shareDrift, vmDecision, whenBusy } from "./vm-decision.ts";
export { hasSizeChanges, vmSizeDrift, vmSizeText } from "./vm-size.ts";
