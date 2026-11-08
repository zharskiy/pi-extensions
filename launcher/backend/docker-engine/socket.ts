import { join } from "node:path";

export const ENGINE_PROFILE = "pi-sandbox";

export const ENGINE_SOCKET_DISPLAY = `~/.colima/${ENGINE_PROFILE}/docker.sock`;

export const engineSocketPath = (home: string) => join(home, ".colima", ENGINE_PROFILE, "docker.sock");
