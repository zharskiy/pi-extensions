import { writeFileSync } from "node:fs";
import net from "node:net";

const LOOPBACKS = ["127.0.0.1", "::1"];

const [status, host, ...ports] = process.argv.slice(2);

const forward = (port) => (client) => {
  const upstream = net.connect({ host, port, allowHalfOpen: true });

  client.setNoDelay(true);

  upstream.setNoDelay(true);

  client.on("error", () => upstream.destroy());

  upstream.on("error", () => client.destroy());

  client.pipe(upstream);

  upstream.pipe(client);
};

const listen = (port, address) =>
  new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true }, forward(port));

    server.on("error", (error) => reject(new Error(`port ${port} on ${address}: ${error.message}`)));

    server.listen({ host: address, port, ipv6Only: address.includes(":") }, resolve);
  });

try {
  await Promise.all(ports.flatMap((port) => LOOPBACKS.map((address) => listen(Number(port), address))));

  writeFileSync(status, "");
} catch (error) {
  writeFileSync(status, `${error.message}\n`);

  process.exit(1);
}
