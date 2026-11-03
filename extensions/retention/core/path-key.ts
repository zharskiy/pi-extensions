import { resolve } from "node:path";

const FOLDS_CASE = process.platform === "darwin" || process.platform === "win32";

export const pathKey = (path: string) => (FOLDS_CASE ? resolve(path).toLowerCase() : resolve(path));
