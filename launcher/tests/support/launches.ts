import { newLaunchId, registerLaunch } from "../../grants/index.ts";
import { processMark } from "../../shared/index.ts";

export interface HeldLaunch {
  launchId?: string;
  startedAt?: number;
}

export const registerLiveLaunch = async (stateDir: string, repoHash: string, held: HeldLaunch = {}) => {
  const launch = { launchId: newLaunchId(), ...(await processMark()), repoHash, startedAt: 1, ...held };

  await registerLaunch(stateDir, launch);

  return launch;
};
