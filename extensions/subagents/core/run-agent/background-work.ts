type Stage = "running" | "settled" | "sent" | "answered";

type BackgroundWork = {
  started(batchId: string): void;
  settled(batchId: string): void;
  sent(): void;
  answered(): void;
  idle(aborted: boolean): void;
};

export const createBackgroundWork = (publish: (count: number) => void): BackgroundWork => {
  const stages = new Map<string, Stage>();
  let published: number | undefined;

  const sync = () => {
    if (stages.size === published) {
      return;
    }

    published = stages.size;

    publish(published);
  };

  const advance = (from: Stage, to: Stage) => {
    stages.forEach((stage, batchId) => {
      if (stage === from) {
        stages.set(batchId, to);
      }
    });
  };

  const drop = (done: Stage[]) => {
    stages.forEach((stage, batchId) => {
      if (done.includes(stage)) {
        stages.delete(batchId);
      }
    });
  };

  return {
    started: (batchId) => {
      stages.set(batchId, "running");
      sync();
    },
    settled: (batchId) => {
      if (stages.has(batchId)) {
        stages.set(batchId, "settled");
      }
    },
    sent: () => {
      advance("settled", "sent");
    },
    answered: () => {
      advance("sent", "answered");
    },
    idle: (aborted) => {
      drop(aborted ? ["sent", "answered"] : ["answered"]);
      sync();
    },
  };
};
