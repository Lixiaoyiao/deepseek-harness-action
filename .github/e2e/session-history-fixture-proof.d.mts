import type { HistoryFixtureReceipt } from "./session-history-fixture.mjs";
export const historicalHarnessPaths: readonly string[];
export function fixtureKeyHash(key: string): string;
export function fixtureCheckpointName(
  binding: Readonly<Record<string, unknown>>,
  runAttempt: number,
  generation: number,
): string;
export function assertOrphanFixtureProof(
  proof: unknown,
  expected: Readonly<Record<string, unknown>>,
): HistoryFixtureReceipt;
export function assertOrphanFixtureProvenance(options: {
  readonly receipt: unknown;
  readonly sourceProof: unknown;
  readonly sourceRun: Readonly<Record<string, unknown>>;
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly history: Readonly<Record<string, unknown>>;
}): HistoryFixtureReceipt;
export function assertExpiredFixtureProvenance(options: {
  readonly receipt: unknown;
  readonly sourceProof: unknown;
  readonly sourceRun: Readonly<Record<string, unknown>>;
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
  readonly history: Readonly<Record<string, unknown>>;
  readonly archive: Uint8Array;
  readonly sourceHarness?: {
    readonly commit: Readonly<Record<string, unknown>>;
    readonly tree: Readonly<Record<string, unknown>>;
    readonly files: Readonly<Record<string, Uint8Array>>;
  };
}): HistoryFixtureReceipt;
