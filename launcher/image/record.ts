import { readJsonObject, stateLayout, writeJsonFile } from "../shared/index.ts";

export interface LayerRecord {
  tag: string;
  id: string;
  digest: string;
  inputsHash: string;
}

export interface ImageRecord {
  reference: string;
  digest: string;
  id: string;
  inputsHash: string;
  layer?: LayerRecord;
}

const recordFileOf = (stateDir: string) => stateLayout(stateDir).imageRecord;

export const readImageRecord = async (stateDir: string): Promise<Partial<ImageRecord> | undefined> =>
  readJsonObject(recordFileOf(stateDir));

export const writeImageRecord = (stateDir: string, record: ImageRecord) =>
  writeJsonFile(recordFileOf(stateDir), record);

export const isImageRecord = (record: Partial<ImageRecord> | undefined): record is ImageRecord =>
  typeof record?.reference === "string" &&
  typeof record.digest === "string" &&
  typeof record.id === "string" &&
  typeof record.inputsHash === "string";
