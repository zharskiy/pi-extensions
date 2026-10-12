import type { AgentDefinition, AgentRecord, AgentRegistry, Worktree } from "../../model/types.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";

type Placement = { cwd: string; created?: Worktree } | { error: string };

export const createPlacer = (registry: AgentRegistry) => {
  const place = async (
    record: AgentRecord,
    definition: AgentDefinition,
    sessionCwd: string,
  ): Promise<Placement> => {
    if (!definition.worktree) {
      return { cwd: sessionCwd };
    }

    const inherited = record.predecessorId ? registry.get(record.predecessorId)?.worktree : undefined;

    if (inherited) {
      registry.update(record.id, { worktree: inherited });
      return { cwd: inherited.cwd };
    }

    const created = await createWorktree(sessionCwd, record.dir, record.id);

    if (!created.ok) {
      return { error: `worktree failed: ${created.error}` };
    }

    registry.update(record.id, { worktree: created.worktree });

    return { cwd: created.worktree.cwd, created: created.worktree };
  };

  const discardWorktree = async (record: AgentRecord, worktree: Worktree, sessionCwd: string) => {
    const removed = await removeWorktree(sessionCwd, worktree);

    if (removed) {
      registry.update(record.id, { worktree: undefined });
    }
  };

  return { place, discardWorktree };
};
