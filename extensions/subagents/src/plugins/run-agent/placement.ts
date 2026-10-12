import type { SessionInfo } from "../../../../../core/adapter/contract.ts";
import type { AgentDefinition, AgentRecord, AgentRegistry, Worktree } from "../../model/types.ts";
import { type Worktrees, worktreeBranch } from "./worktree.ts";

type Placement = { cwd: string; created?: Worktree } | { error: string };

type PlacerDeps = {
  registry: AgentRegistry;
  session: () => SessionInfo | undefined;
  worktrees: Worktrees;
  now: () => number;
};

export const createPlacer = (deps: PlacerDeps) => {
  const place = async (record: AgentRecord, definition: AgentDefinition): Promise<Placement> => {
    const sessionCwd = deps.session()?.cwd ?? process.cwd();

    if (!definition.worktree) {
      return { cwd: sessionCwd };
    }

    const inherited = record.predecessorId ? deps.registry.get(record.predecessorId)?.worktree : undefined;

    if (inherited) {
      deps.registry.update(record.id, { worktree: inherited });
      return { cwd: inherited.cwd };
    }

    const created = await deps.worktrees.create(
      sessionCwd,
      record.dir,
      worktreeBranch(record.id, deps.now().toString(36)),
    );

    if (!created.ok) {
      return { error: `worktree failed: ${created.error}` };
    }

    deps.registry.update(record.id, { worktree: created.worktree });

    return { cwd: created.worktree.cwd, created: created.worktree };
  };

  const discardWorktree = async (record: AgentRecord, worktree: Worktree) => {
    const sessionCwd = deps.session()?.cwd ?? process.cwd();
    const removed = await deps.worktrees.remove(sessionCwd, worktree);

    if (removed) {
      deps.registry.update(record.id, { worktree: undefined });
    }
  };

  return { place, discardWorktree };
};
