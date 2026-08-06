/** Promise helpers shared by the background, content script and popup. */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reject with `message` if `promise` has not settled within `ms`.
 *
 * The losing promise is not cancellable — callers must treat a timeout as
 * "gave up waiting", not "the work stopped".
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Serialise read-modify-write style operations onto a single chain so two of
 * them can never interleave at an await boundary. A rejected op must not break
 * the chain, so its result is swallowed before the next op links on.
 */
export function createWriteChain() {
  let chain: Promise<unknown> = Promise.resolve();
  return function serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = chain.then(op, op);
    chain = run.catch(() => { });
    return run;
  };
}
