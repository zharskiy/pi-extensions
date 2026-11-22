import { GUEST_PROXY_HOST, GUEST_PROXY_PORT } from "../backend/index.ts";
import { jsonText } from "../shared/index.ts";
import type { SandboxStatusInput } from "./types.ts";

const STATUS_VERSION = 1;

export const statusFile = (status: SandboxStatusInput) => {
  const proxyUrl = `http://${GUEST_PROXY_HOST}:${GUEST_PROXY_PORT}`;

  return Buffer.from(
    jsonText({
      version: STATUS_VERSION,
      proxy: { url: proxyUrl, denials: `${proxyUrl}/denials`, health: `${proxyUrl}/healthz` },
      ...status,
      volumes: status.volumes.map((target) => ({ target })),
      binds: status.binds.map((target) => ({ target })),
    }),
  );
};
