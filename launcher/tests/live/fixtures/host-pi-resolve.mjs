import dns from "node:dns";

const PI_CLI = "pi-coding-agent";

const overrides = new Map(
  (process.env.PI_SANDBOX_TEST_RESOLVE ?? "")
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

if ((process.argv[1] ?? "").includes(PI_CLI) && overrides.size > 0) {
  dns.lookup = lookup;
}
