import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDenialPages } from "../../proxy/denial-page.ts";
import type { LeafCertificate } from "../../proxy/tls-ca.ts";
import { createStateDir, openCa, removeDir } from "./harness.ts";

const state: { stateDir: string; leaf: LeafCertificate } = {
  stateDir: "",
  leaf: { key: "", cert: "" },
};

beforeAll(async () => {
  state.stateDir = await createStateDir();
  state.leaf = await (await openCa(state.stateDir)).ephemeralLeaf("page.test");
}, 30_000);

afterAll(async () => {
  await removeDir(state.stateDir);
});

const countingPages = () => {
  const minted: string[] = [];
  const pages = createDenialPages({
    leaf: async (host) => {
      minted.push(host);

      return state.leaf;
    },
    mintsPerMinute: 1_000,
  });

  return { pages, minted };
};

const names = (count: number) => Array.from({ length: count }, (_, index) => `host-${index}.test`);

describe("denial page certificates in memory", () => {
  it("keeps 256 names and evicts the least recently used one first", async () => {
    const { pages, minted } = countingPages();

    await names(256).reduce(async (previous, host) => {
      await previous;

      await pages.context(host);
    }, Promise.resolve());

    await pages.context("host-0.test");

    await pages.context("extra.test");

    await pages.context("host-0.test");

    await pages.context("host-1.test");

    expect(minted.filter((host) => host === "host-0.test")).toHaveLength(1);
    expect(minted.filter((host) => host === "host-1.test")).toHaveLength(2);
    expect(minted).toHaveLength(258);
  });
});
