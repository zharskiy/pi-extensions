export interface Endpoint {
  host: string;
  port?: number;
}

export type EndpointResult = { endpoint: Endpoint } | { local: string } | { invalid: true };

const LOOPBACK = /^(localhost|.*\.localhost|127(\.\d+){3}|\[::1\]|::1|0\.0\.0\.0)$/;

const TLS_PORT = 443;

export const endpointOf = (url: unknown): EndpointResult => {
  if (typeof url !== "string") {
    return { invalid: true };
  }

  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (parsed.protocol !== "https:" || LOOPBACK.test(host)) {
      return { local: host };
    }

    const port = parsed.port === "" ? TLS_PORT : Number(parsed.port);

    return { endpoint: port === TLS_PORT ? { host } : { host, port } };
  } catch {
    return { invalid: true };
  }
};

export const endpointKey = (endpoint: Endpoint) =>
  endpoint.port === undefined ? endpoint.host : `${endpoint.host}:${endpoint.port}`;

export const uniqueEndpoints = (endpoints: Endpoint[]) => [
  ...new Map(endpoints.map((endpoint) => [endpointKey(endpoint), endpoint])).values(),
];
