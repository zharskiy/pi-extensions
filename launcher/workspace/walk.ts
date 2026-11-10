interface LevelStep<P, L, S> {
  list(pending: P): Promise<L>;
  children(level: L): P[];
  fold(state: S, levels: L[]): S;
}

interface Walked<S> {
  state: S;
  complete: boolean;
}

export const walkLevels = async <P, L, S>(
  pending: P[],
  budget: number,
  state: S,
  step: LevelStep<P, L, S>,
): Promise<Walked<S>> => {
  if (pending.length === 0) {
    return { state, complete: true };
  }

  if (budget <= 0) {
    return { state, complete: false };
  }

  const taken = pending.slice(0, budget);
  const levels = await Promise.all(taken.map((entry) => step.list(entry)));
  const rest = await walkLevels(
    levels.flatMap((level) => step.children(level)),
    budget - taken.length,
    step.fold(state, levels),
    step,
  );

  return { state: rest.state, complete: rest.complete && taken.length === pending.length };
};
