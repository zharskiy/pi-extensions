export { createColimaBackend } from "./colima/backend.ts";
export { busyText, ENGINE_PROFILE, sessionsRunning, shareText, VM_HOST_ALIAS } from "./colima/profile.ts";
export { PROXY_ALIAS as GUEST_PROXY_HOST, RELAY_LISTEN_PORT as GUEST_PROXY_PORT } from "./colima/relay.ts";
export { RELAY_PREAMBLE_VARIABLE, RELAY_SCRIPT } from "./colima/relay-script.ts";
export { engineUnreachable } from "./colima/vm.ts";
export { execCapture } from "./exec-capture.ts";
export { installIdOf, networkName, relayName, SERVICES_ALIAS } from "./install.ts";
export { isOlderBuild, isSession, LABELS, roleOf } from "./labels.ts";
export type {
  Backend,
  BuildOptions,
  ContainerInspect,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  ExecIo,
  ExecSpec,
  ImageInfo,
  ImageSummary,
  MountSpec,
  NetworkRef,
  RelayRequest,
  TerminalSize,
  Vm,
  VmApplied,
  VmBusy,
  VmDesired,
  VmFileCache,
  VmInspect,
  VmPath,
  VmPhase,
  VmShare,
  VmSize,
  VmSpec,
  VmTarget,
  VmWatch,
  VolumeSummary,
} from "./types.ts";
export { shareDrift, vmDecision, whenBusy } from "./vm-decision.ts";
export { hasSizeChanges, vmSizeDrift, vmSizeText } from "./vm-size.ts";
