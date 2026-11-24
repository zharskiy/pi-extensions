export const RELAY_PREAMBLE_VARIABLE = "PINATA_RELAY_PREAMBLE";

export const RELAY_SCRIPT = `
const net = require("node:net");
const [listenPort, upstreamHost, upstreamPort, clientSubnet] = process.argv.slice(1);
const [subnetAddress, subnetPrefix] = clientSubnet.split("/");
const clients = new net.BlockList();
clients.addSubnet(subnetAddress, Number(subnetPrefix), "ipv4");
const preamble = process.env.${RELAY_PREAMBLE_VARIABLE} + "\\n";
delete process.env.${RELAY_PREAMBLE_VARIABLE};
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  if (!clients.check(client.remoteAddress ?? "", "ipv4")) {
    client.destroy();
    return;
  }

  const upstream = net.connect({ host: upstreamHost, port: Number(upstreamPort), allowHalfOpen: true });
  upstream.write(preamble);
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen({ host: "0.0.0.0", port: Number(listenPort), backlog: 4096 });
`.trim();
