import type { ArtifactClient } from "@actions/artifact";

export interface HistoryFixtureReceipt {
  readonly schemaVersion: 1;
  readonly seeded: true;
  readonly kind: "corrupt" | "orphan" | "expired";
  readonly repository: string;
  readonly runId: number;
  readonly runAttempt: number;
  readonly candidateSha: string;
  readonly harnessSha: string;
  readonly dshMode: string;
  readonly sourceKeyHash: string;
  readonly targetKeyHash: string;
  readonly sourceArtifactId: number;
  readonly sourceArtifactName: string;
  readonly sourceArchiveSha256: string;
  readonly artifactId: number;
  readonly artifactName: string;
  readonly archiveSha256: string;
  readonly generation: number;
  readonly binding: Readonly<Record<string, unknown>>;
  readonly expiry?: {
    readonly createdAt: string;
    readonly sourceExpiresAt: string;
    readonly expiresAt: string;
    readonly preparedAt: string;
  };
}

export function seedSessionHistoryFixture(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly directory: string;
  readonly artifactClient: Pick<
    ArtifactClient,
    "getArtifact" | "deleteArtifact" | "uploadArtifact"
  >;
}): Promise<HistoryFixtureReceipt>;
