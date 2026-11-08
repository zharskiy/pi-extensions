import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const RESOLVED_SCRIPTS = ["pi-coding-agent", "hostpi/mcp-discover.mjs", "proxy/daemon"];

const overrides = new Map(
  (new URL(import.meta.url).searchParams.get("hosts") ?? "")
    .split(",")
    .map((pair) => pair.split("=").map((part) => part.trim()))
    .filter(([name, address]) => name && address),
);

const original = dns.lookup;

const family = (address) => (address.includes(":") ? 6 : 4);

const lookup = (hostname, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  const settings = typeof options === "object" && options !== null ? options : {};
  const address = overrides.get(String(hostname).toLowerCase());

  if (address === undefined) {
    return original(hostname, options, callback);
  }

  if (settings.all === true) {
    return process.nextTick(() => done(null, [{ address, family: family(address) }]));
  }

  return process.nextTick(() => done(null, address, family(address)));
};

const script = process.argv[1] ?? "";

if (RESOLVED_SCRIPTS.some((name) => script.includes(name)) && overrides.size > 0) {
  dns.lookup = lookup;

  syncBuiltinESMExports();
}
