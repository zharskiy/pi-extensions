type Stage = "running" | "settled" | "sent";

type BackgroundWork = {
  started(batchId: string): void;
  settled(batchId: string): void;
  sent(): void;
  answered(): void;
  aborted(): void;
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

  const dropSent = () => {
    stages.forEach((stage, batchId) => {
      if (stage === "sent") {
        stages.delete(batchId);
      }
    });

    sync();
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
      stages.forEach((stage, batchId) => {
        if (stage === "settled") {
          stages.set(batchId, "sent");
        }
      });
    },
    answered: dropSent,
    aborted: dropSent,
  };
};
