import { rm } from "node:fs/promises";
import { knownRepos, readJsonObject, stateLayout, writeJsonFile } from "../shared/index.ts";

export interface BaseRecord {
  id: string;
  digest: string;
  inputsHash: string;
  pi?: string;
}

const recordFileOf = (stateDir: string) => stateLayout(stateDir).imageRecord;

const isBaseRecord = (base: unknown): base is BaseRecord => {
  const record = base as Partial<BaseRecord> | undefined;

  return (
    typeof record?.id === "string" &&
    typeof record.digest === "string" &&
    typeof record.inputsHash === "string"
  );
};

export const readBaseRecord = async (stateDir: string): Promise<BaseRecord | undefined> => {
  const base = (await readJsonObject(recordFileOf(stateDir)))?.base;

  return isBaseRecord(base) ? base : undefined;
};

export const writeBaseRecord = (stateDir: string, base: BaseRecord) =>
  writeJsonFile(recordFileOf(stateDir), { base });

export const writeWantedLayer = (stateDir: string, repoHash: string, tag: string | undefined) => {
  const path = stateLayout(stateDir).repo(repoHash).image;

  return tag === undefined ? rm(path, { force: true }) : writeJsonFile(path, { layer: tag });
};

const wantedLayerOf = async (stateDir: string, repoHash: string) => {
  const layer = (await readJsonObject(stateLayout(stateDir).repo(repoHash).image))?.layer;

  return typeof layer === "string" ? [layer] : [];
};

export const wantedLayers = async (stateDir: string) => {
  const repos = await knownRepos(stateDir);
  const tags = await Promise.all(repos.map((repoHash) => wantedLayerOf(stateDir, repoHash)));

  return new Set(tags.flat());
};
