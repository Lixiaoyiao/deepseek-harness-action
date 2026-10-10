import type { HistoryFixtureReceipt } from "./session-history-fixture.mjs";
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
