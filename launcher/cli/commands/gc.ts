import { access } from "node:fs/promises";
import type { Backend } from "../../backend/index.ts";
import { collectGarbage, LABELS } from "../../container/index.ts";
import { liveSessions } from "../../grants/index.ts";
import { stateLayout } from "../../shared/index.ts";
import { type CliDeps, writeLine, writeLines } from "../deps.ts";
import { openBackend, openContext } from "../launch.ts";
import { pruneEndedGrants } from "../sessions.ts";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const servesAny = async (stateDir: string, policyHash: string, repoHashes: string[]) =>
  (
    await Promise.all(
      repoHashes.map((repo) => exists(stateLayout(stateDir).proxyRepoToken(policyHash, repo))),
    )
  ).some(Boolean);

const livePolicyHashes = async (stateDir: string, policyHashes: string[], repoHashes: string[]) => {
  const serving = await Promise.all(policyHashes.map((hash) => servesAny(stateDir, hash, repoHashes)));

  return policyHashes.filter((_hash, index) => serving[index]);
};

const reposWithContainers = async (backend: Backend) =>
  (await backend.findContainers({ [LABELS.managed]: "true" }))
    .filter((container) => container.labels[LABELS.relay] !== "true")
    .flatMap((container) => {
      const repoHash = container.labels[LABELS.repoHash];

      return repoHash === undefined ? [] : [repoHash];
    });

export const gcCommand = async (deps: CliDeps) => {
  const { effective, stateDir } = await openContext(deps);
  const backend = await openBackend(deps, effective.config);
  const instances = await deps.proxy.list(stateDir);
  const repoHashes = [...new Set((await liveSessions(stateDir)).map((session) => session.repoHash))];
  const policyHashes = await livePolicyHashes(
    stateDir,
    instances.map((instance) => instance.policyHash),
    repoHashes,
  );
  const garbage = await collectGarbage(backend, { repoHashes, policyHashes });
  const idle = instances.filter((instance) => !garbage.policyHashesInUse.includes(instance.policyHash));

  await Promise.all(idle.map((instance) => deps.proxy.stop(stateDir, instance.policyHash)));

  const networks = await backend.pruneNetworks([
    ...new Set([...(await reposWithContainers(backend)), ...repoHashes]),
  ]);

  writeLines(deps.stdout, [
    ...garbage.containers.map((container) => `removed ${container.name} (${container.id})`),
    ...garbage.relays.map((relay) => `removed relay ${relay.name} (${relay.id})`),
    ...idle.map((instance) => `stopped proxy pid ${instance.pid} port ${instance.port}`),
    ...networks.map((name) => `removed network ${name}`),
  ]);

  writeLine(deps.stdout, `removed ${plural(garbage.containers.length, "stopped container")}`);

  const pruned = await pruneEndedGrants(deps, stateDir);

  writeLine(deps.stdout, `pruned ${plural(pruned, "ended grant")}`);

  return 0;
};
