export interface SessionProducerRun {
  readonly repository: string;
  readonly id: number;
  readonly title: string;
  readonly headSha: string;
  readonly conclusion: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

/** Checks producer intervals and returns the original run objects as evidence. */
export function inspectSessionRunConcurrency<
  TFirst extends SessionProducerRun,
  TSecond extends SessionProducerRun,
>(
  first: TFirst,
  second: TSecond,
  relation: "same-key" | "different-key",
): {
  readonly schemaVersion: 1;
  readonly qualified: true;
  readonly relation: "same-key" | "different-key";
  readonly overlapMilliseconds: number;
  readonly first: TFirst;
  readonly second: TSecond;
};
