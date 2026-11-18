import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const TRUST_FILE = "trust.pem";

export const placeBuildTrust = async (dir: string, trustPem: string | undefined) => {
  if (trustPem === undefined) {
    await writeFile(join(dir, TRUST_FILE), "");

    return;
  }

  await copyFile(trustPem, join(dir, TRUST_FILE));
};
