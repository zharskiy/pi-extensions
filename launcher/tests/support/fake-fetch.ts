import type { FetchText, FetchTextResult } from "../../config/index.ts";

type FakeRoute = FetchTextResult | Error | ((url: string) => FetchTextResult | Promise<FetchTextResult>);

interface FakeFetchCall {
  url: string;
  timeoutMs: number;
}

const settle = async (route: FakeRoute | undefined, url: string) => {
  if (route === undefined) {
    throw new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`);
  }

  if (route instanceof Error) {
    throw route;
  }

  return typeof route === "function" ? route(url) : route;
};

export const createFakeFetchText = (routes: Record<string, FakeRoute> = {}) => {
  const calls: FakeFetchCall[] = [];
  const table = new Map(Object.entries(routes));

  const fetchText: FetchText = async (url, options) => {
    calls.push({ url, timeoutMs: options.timeoutMs });

    return settle(table.get(url), url);
  };

  const route = (url: string, response: FakeRoute) => {
    table.set(url, response);
  };

  return { fetchText, calls, route };
};
