import { readJsonObject, stateLayout, writeJsonFile } from "../shared/index.ts";

export interface BaseRecord {
  id: string;
  digest: string;
  inputsHash: string;
}

interface ImageRecord {
  base?: BaseRecord;
  layer?: string;
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

const readRecord = async (stateDir: string): Promise<ImageRecord> => {
  const record = await readJsonObject(recordFileOf(stateDir));

  return {
    ...(isBaseRecord(record?.base) ? { base: record.base } : {}),
    ...(typeof record?.layer === "string" ? { layer: record.layer } : {}),
  };
};

const updateRecord = async (stateDir: string, change: ImageRecord) =>
  writeJsonFile(recordFileOf(stateDir), { ...(await readRecord(stateDir)), ...change });

export const readBaseRecord = async (stateDir: string) => (await readRecord(stateDir)).base;

export const writeBaseRecord = (stateDir: string, base: BaseRecord) => updateRecord(stateDir, { base });

export const currentLayer = async (stateDir: string) => (await readRecord(stateDir)).layer;

export const writeCurrentLayer = (stateDir: string, layer: string | undefined) =>
  updateRecord(stateDir, { layer });
