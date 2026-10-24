import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";

const RESULTS_ENV = "PI_EVAL_RESULTS";

const OBSERVATIONS = "observations.jsonl";

const resultsDir = () => process.env[RESULTS_ENV];

const folderName = (label: string) => label.replace(/[^\w.-]+/g, "-");

export const snapshotSessions = (label: string, files: string[]) => {
  const results = resultsDir();

  if (!results) {
    return undefined;
  }

  const sessions = join(results, "sessions");

  mkdirSync(sessions, { recursive: true });

  const dir = mkdtempSync(join(sessions, `${folderName(label)}-`));

  files.filter(existsSync).forEach((file, index) => {
    copyFileSync(file, join(dir, `${index + 1}-${basename(file)}`));
  });

  return dir;
};

const isInside = (root: string, dir: string) => {
  const path = relative(root, dir);

  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
};

export const dropSnapshot = (dir: string) => {
  const results = resultsDir();

  if (!results || !isInside(join(results, "sessions"), dir)) {
    return;
  }

  rmSync(dir, { recursive: true, force: true });
};

export const appendObservation = (line: string) => {
  const results = resultsDir();

  if (!results) {
    return;
  }

  mkdirSync(results, { recursive: true });
  appendFileSync(join(results, OBSERVATIONS), `${line}\n`);
};
