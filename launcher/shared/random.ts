import { randomBytes } from "node:crypto";

export const randomHex = (bytes: number) => randomBytes(bytes).toString("hex");
