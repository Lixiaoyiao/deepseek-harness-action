export const TRACKING_MARKER_PREFIX = "<!-- dsh-action:v1";

export type TrackingKind = "summary" | "finding" | "diagnosis" | "task" | "write";

export type TrackingMarker =
  { kind: "finding"; fingerprint: string } | { kind: Exclude<TrackingKind, "finding"> };

export interface TrackableComment {
  id: number | string;
  body?: string | null;
  user?: { id?: number | null } | null;
  commit_id?: string | null;
  path?: string | null;
  line?: number | null;
  side?: string | null;
}

export interface TrackingIndex<T extends TrackableComment> {
  summaries: T[];
  diagnoses: T[];
  tasks: T[];
  writes: T[];
  findings: Map<string, T>;
}

const MARKER_PATTERN =
  /<!-- dsh-action:v1 kind=(summary|diagnosis|task|write|finding)(?: fingerprint=([a-f0-9]{64}))? -->/gu;
const RESERVED_MARKER_PATTERN = /<!--\s*dsh-action\s*:[\s\S]*?-->/giu;

export function createTrackingMarker(marker: TrackingMarker): string {
  if (marker.kind === "finding") {
    if (!/^[a-f0-9]{64}$/u.test(marker.fingerprint)) {
      throw new TypeError("finding fingerprint must be 64 lowercase hexadecimal characters");
    }
    return `${TRACKING_MARKER_PREFIX} kind=finding fingerprint=${marker.fingerprint} -->`;
  }
  return `${TRACKING_MARKER_PREFIX} kind=${marker.kind} -->`;
}

export function parseTrackingMarkers(body: string): TrackingMarker[] {
  const markers: TrackingMarker[] = [];
  for (const match of body.matchAll(MARKER_PATTERN)) {
    const kind = match[1] as TrackingKind;
    const fingerprint = match[2];
    if (kind === "finding") {
      if (fingerprint !== undefined) markers.push({ kind, fingerprint });
    } else if (fingerprint === undefined) {
      markers.push({ kind });
    }
  }
  return markers;
}

export function parseTrackingMarker(body: string): TrackingMarker | null {
  return parseTrackingMarkers(body)[0] ?? null;
}

/** Remove both valid and malformed attempts at controller-owned markers. */
export function stripTrackingMarkers(body: string): string {
  return body.replace(RESERVED_MARKER_PATTERN, "").trim();
}

/** Index only comments authored by the expected GitHub App/bot numeric ID. */
export function indexTrackingComments<T extends TrackableComment>(
  comments: readonly T[],
  expectedAuthorId: number,
): TrackingIndex<T> {
  const result: TrackingIndex<T> = {
    summaries: [],
    diagnoses: [],
    tasks: [],
    writes: [],
    findings: new Map<string, T>(),
  };

  for (const comment of comments) {
    if (
      comment.user?.id !== expectedAuthorId ||
      comment.body === null ||
      comment.body === undefined
    ) {
      continue;
    }
    for (const marker of parseTrackingMarkers(comment.body)) {
      switch (marker.kind) {
        case "summary":
          result.summaries.push(comment);
          break;
        case "diagnosis":
          result.diagnoses.push(comment);
          break;
        case "task":
          result.tasks.push(comment);
          break;
        case "write":
          result.writes.push(comment);
          break;
        case "finding":
          result.findings.set(marker.fingerprint, comment);
          break;
      }
    }
  }
  return result;
}

export const buildTrackingIndex = indexTrackingComments;
