import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export type StartReading = { start: string } | { failed: "tool" | "process" };

const START_FIELD = 19;

const PROCESS_ERRORS = ["ENOENT", "ESRCH", "EACCES", "EPERM"];

const psStart = (pid: number) =>
  new Promise<StartReading>((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C" } }, (error, stdout) => {
      const text = stdout.trim().split(/\s+/).join("-");

      if (error !== null) {
        resolve({ failed: typeof error.code === "number" && error.signal === null ? "process" : "tool" });

        return;
      }

      resolve(text === "" ? { failed: "process" } : { start: text });
    });
  });

const procText = async (pid: number): Promise<{ text: string } | { failed: "tool" | "process" }> => {
  try {
    return { text: await readFile(`/proc/${pid}/stat`, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";

    return { failed: PROCESS_ERRORS.includes(code) ? ("process" as const) : ("tool" as const) };
  }
};

const procStart = async (pid: number): Promise<StartReading> => {
  const read = await procText(pid);

  if (!("text" in read)) {
    return read;
  }

  const start = read.text
    .slice(read.text.lastIndexOf(")") + 1)
    .trim()
    .split(" ")[START_FIELD];

  return start === undefined || start === "" ? { failed: "process" } : { start };
};

export const readProcessStart = (pid: number): Promise<StartReading> =>
  process.platform === "linux" ? procStart(pid) : psStart(pid);

export const processStart = async (pid: number): Promise<string | undefined> => {
  const reading = await readProcessStart(pid);

  return "start" in reading ? reading.start : undefined;
};
