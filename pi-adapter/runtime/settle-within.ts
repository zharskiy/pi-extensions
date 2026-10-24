export const settleWithin = (promise: Promise<unknown>, ms: number) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);

    promise
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        done();
      });
  });
