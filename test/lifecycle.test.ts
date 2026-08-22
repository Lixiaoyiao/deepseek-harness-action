import { describe, expect, it, vi } from "vitest";

import { DshAbortedError } from "../src/dsh/errors.js";
import {
  installCancellationHandlers,
  throwIfCancelled,
  type CancellationSignal,
  type SignalSource,
} from "../src/lifecycle/cancellation.js";
import { phaseTimeoutMs, settleWithin } from "../src/lifecycle/deadline.js";

class FakeSignalSource implements SignalSource {
  public readonly listeners = new Map<CancellationSignal, Set<() => void>>();

  public once(signal: CancellationSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  public removeListener(signal: CancellationSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  public emit(signal: CancellationSignal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }
}

describe("run-scoped lifecycle controls", () => {
  it("bounds every phase by both its cap and the immutable total deadline", () => {
    expect(phaseTimeoutMs(20_000, 5_000, () => 1_000)).toBe(5_000);
    expect(phaseTimeoutMs(4_000, 5_000, () => 1_000)).toBe(3_000);
    expect(phaseTimeoutMs(1_000, 5_000, () => 1_001)).toBe(0);
  });

  it("turns SIGINT/SIGTERM into one idempotent abort and removes both handlers", () => {
    const source = new FakeSignalSource();
    const handle = installCancellationHandlers(source);

    source.emit("SIGTERM");
    source.emit("SIGINT");

    expect(handle.signal.aborted).toBe(true);
    expect(handle.signal.reason).toBeInstanceOf(DshAbortedError);
    expect(handle.receivedSignal).toBe("SIGTERM");
    expect(() => throwIfCancelled(handle.signal)).toThrow(DshAbortedError);

    handle.dispose();
    handle.dispose();
    expect(source.listeners.get("SIGINT")?.size).toBe(0);
    expect(source.listeners.get("SIGTERM")?.size).toBe(0);
  });

  it("returns control when a best-effort finalizer exceeds its grace period", async () => {
    vi.useFakeTimers();
    try {
      const pending = new Promise<void>(() => undefined);
      const resultPromise = settleWithin(pending, 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(resultPromise).resolves.toEqual({ settled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("observes a rejection when the shared budget is already exhausted", async () => {
    const failure = Promise.reject(new Error("late cleanup failure"));
    await expect(settleWithin(failure, 0)).resolves.toEqual({ settled: false });
    await Promise.resolve();
  });

  it("observes a rejection when cancellation already won before the race", async () => {
    const controller = new AbortController();
    const cancellation = new DshAbortedError();
    controller.abort(cancellation);
    const failure = Promise.reject(new Error("late cancelled failure"));
    await expect(settleWithin(failure, 5_000, controller.signal)).rejects.toBe(cancellation);
    await Promise.resolve();
  });

  it("clears the phase timer immediately when cancellation wins the race", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const pending = new Promise<void>(() => undefined);
      const resultPromise = settleWithin(pending, 30_000, controller.signal);
      expect(vi.getTimerCount()).toBe(1);
      const cancellation = new DshAbortedError();
      controller.abort(cancellation);
      await expect(resultPromise).rejects.toBe(cancellation);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
