import { resolve } from "node:path";
import { createPiExtension } from "../../../core/adapter/pi-adapter.ts";
import { createNotifications } from "./notifications.ts";

const root = resolve(import.meta.dirname, "..");

export default createPiExtension(
  (host) => {
    createNotifications(host);
  },
  { root, namespace: "pi-notifications" },
);
