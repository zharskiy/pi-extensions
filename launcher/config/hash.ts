import { stableHash } from "../shared/index.ts";
import type { SandboxConfig } from "./types.ts";

export const configHash = (config: SandboxConfig) => stableHash(config);
