import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "../shared/index.ts";

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

const RECORD_FILE = "image.json";

const recordFileOf = (stateDir: string) => join(stateDir, RECORD_FILE);

export const readImageRecord = (stateDir: string) =>
  readJsonFile<Partial<ImageRecord>>(recordFileOf(stateDir)).catch(() => undefined);

export const writeImageRecord = (stateDir: string, record: ImageRecord) =>
  writeJsonFile(recordFileOf(stateDir), record);

export const isImageRecord = (record: Partial<ImageRecord> | undefined): record is ImageRecord =>
  typeof record?.reference === "string" &&
  typeof record.digest === "string" &&
  typeof record.id === "string" &&
  typeof record.inputsHash === "string";
