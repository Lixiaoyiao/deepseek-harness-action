import { DshAbortedError } from "../dsh/errors.js";

export type CancellationSignal = "SIGINT" | "SIGTERM";

export interface SignalSource {
  once(signal: CancellationSignal, listener: () => void): unknown;
  removeListener(signal: CancellationSignal, listener: () => void): unknown;
}

export interface CancellationHandle {
  readonly signal: AbortSignal;
  readonly receivedSignal: CancellationSignal | undefined;
  dispose(): void;
}

/** Install run-scoped handlers without taking ownership of process exit. */
export function installCancellationHandlers(
  source: SignalSource = process,
  controller = new AbortController(),
): CancellationHandle {
  let receivedSignal: CancellationSignal | undefined;
  let disposed = false;
  const cancel = (signal: CancellationSignal): void => {
    if (disposed || receivedSignal !== undefined) return;
    receivedSignal = signal;
    controller.abort(new DshAbortedError());
  };
  const onInterrupt = (): void => cancel("SIGINT");
  const onTerminate = (): void => cancel("SIGTERM");
  source.once("SIGINT", onInterrupt);
  source.once("SIGTERM", onTerminate);
  return {
    signal: controller.signal,
    get receivedSignal() {
      return receivedSignal;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      source.removeListener("SIGINT", onInterrupt);
      source.removeListener("SIGTERM", onTerminate);
    },
  };
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error ? signal.reason : new DshAbortedError();
}
