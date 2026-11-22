import type { Backend, VmBusy } from "../backend/index.ts";
import { liveLaunches } from "../grants/index.ts";

export const busyLaunches = async (stateDir: string, except?: string) =>
  (await liveLaunches(stateDir)).filter((launch) => launch.launchId !== except).length;

const otherInstallSessions = async (backend: Backend) => {
  if (!(await backend.detect()).available) {
    return [];
  }

  const sessions = await backend.listOtherInstallSessions();

  return sessions.map((session) => session.name);
};

export const vmSessions = async (backend: Backend, stateDir: string, except?: string): Promise<VmBusy> => {
  const others = await otherInstallSessions(backend);

  return { count: (await busyLaunches(stateDir, except)) + others.length, others };
};
