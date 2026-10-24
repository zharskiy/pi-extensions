import {
  type AgentDefinition,
  type AgentRecord,
  type AgentRegistry,
  chainLinks,
  isClosed,
  type Worktree,
} from "../model/types.ts";
import { createWorktree, removeWorktree } from "./worktree.ts";

type Placement = { cwd: string } | { error: string };

export const createPlacer = (registry: AgentRegistry) => {
  const release = async (record: AgentRecord, worktree: Worktree) => {
    const cleanup = await removeWorktree(worktree);

    chainLinks(registry, record).forEach((link) => {
      registry.update(link.id, { worktree: { ...worktree, cleanup } });
    });
  };

  const place = async (
    record: AgentRecord,
    definition: AgentDefinition,
    sessionCwd: string,
  ): Promise<Placement> => {
    if (record.worktree) {
      return { cwd: record.worktree.cwd };
    }

    if (!definition.worktree) {
      return { cwd: sessionCwd };
    }

    const created = await createWorktree(sessionCwd, record.id);

    if (!created.ok) {
      return { error: `worktree failed: ${created.error}` };
    }

    const placed = registry.update(record.id, { worktree: created.worktree });

    if (isClosed(placed.state)) {
      await release(placed, created.worktree);
    }

    return { cwd: created.worktree.cwd };
  };

  return { place, release };
};
