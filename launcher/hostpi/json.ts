import { isJsonObject, type JsonObject } from "../shared/index.ts";

export const objectOr = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});
