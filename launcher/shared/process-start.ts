import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

const START_FIELD = 19;

const psStart = (pid: number) =>
  new Promise<string | undefined>((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C" } }, (error, stdout) => {
      const text = stdout.trim().split(/\s+/).join("-");

      resolve(error === null && text !== "" ? text : undefined);
    });
  });

const procStart = async (pid: number) => {
  const text = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  const fields = text
    ?.slice(text.lastIndexOf(")") + 1)
    .trim()
    .split(" ");

  return fields?.[START_FIELD];
};

export const processStart = (pid: number): Promise<string | undefined> =>
  process.platform === "linux" ? procStart(pid) : psStart(pid);
