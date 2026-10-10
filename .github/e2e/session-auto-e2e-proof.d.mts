/** Public interface of the independent automatic Session qualification fixture. */
export function buildSessionTask(
  phase: string,
  challenge: string,
  memory?: string,
): { prompt: string; schema: string };
export function assertSourceProof(proof: unknown, expected: Record<string, unknown>): unknown;
export function resultChecks(
  result: unknown,
  expected: Record<string, unknown>,
): Record<string, boolean>;
export function failureChecks(
  result: unknown,
  expected: Record<string, unknown>,
  actionOutcome: string,
): Record<string, boolean>;
export function selectSessionHistory(
  runs: unknown[],
  current: Record<string, unknown>,
): { status: string; source: { id: number } | undefined };
export function inspectCheckpointArchive(
  input: Uint8Array,
  expected: Record<string, unknown>,
): {
  payload: Buffer;
  payloadSha256: string;
  archiveSha256: string;
  manifestSha256: string;
  eventCount: number;
  generation: number;
};
