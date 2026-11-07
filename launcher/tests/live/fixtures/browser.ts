import { lookup as dnsLookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

export interface BrowserResponse {
  status: number;
  location?: string;
  body: string;
}

export type Resolve = (host: string) => string | undefined;

const lookupWith =
  (resolveHost: Resolve): LookupFunction =>
  (hostname, options, callback) => {
    const address = resolveHost(hostname);

    if (address === undefined) {
      dnsLookup(hostname, options, callback);

      return;
    }

    if (options.all === true) {
      callback(null, [{ address, family: 4 }]);

      return;
    }

    callback(null, address, 4);
  };

export const browserGet = (url: string, ca: string, resolveHost: Resolve = () => undefined) =>
  new Promise<BrowserResponse>((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(target, { method: "GET", ca, lookup: lookupWith(resolveHost) }, (response) => {
      const chunks: Buffer[] = [];

      response.on("data", (chunk: Buffer) => chunks.push(chunk));

      response.once("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          location: response.headers.location,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });

    request.once("error", reject);

    request.end();
  });

export const followRedirects = async (
  url: string,
  ca: string,
  resolve: Resolve = () => undefined,
  limit = 5,
): Promise<BrowserResponse> => {
  const response = await browserGet(url, ca, resolve);

  if (response.location === undefined || limit === 0) {
    return response;
  }

  return followRedirects(new URL(response.location, url).href, ca, resolve, limit - 1);
};
