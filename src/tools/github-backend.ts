/**
 * Transport-only boundary for the Action-owned `github.*` capabilities.
 *
 * Targets are Controller-derived coordinates, not model input or authority
 * bindings. Backends execute GitHub primitives and return narrowed remote
 * state; the GitHub tool gateway owns every authorization and trust decision.
 */
export interface GitHubBackendRequestControl {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface GitHubRepositoryTarget {
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubIssueTarget extends GitHubRepositoryTarget {
  readonly issueNumber: number;
}

export interface GitHubPullTarget extends GitHubRepositoryTarget {
  readonly pullNumber: number;
}

export interface GitHubCommitTarget extends GitHubRepositoryTarget {
  readonly headSha: string;
}

export interface GitHubRepositorySnapshot {
  readonly id: number;
}

export interface GitHubIssueSnapshot {
  readonly kind: "issue" | "pull_request";
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly authorId: number | null;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly state: "open" | "closed";
  readonly stateReason: "completed" | "not_planned" | "reopened" | null;
}

export interface GitHubPullSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly maintainerCanModify: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepositoryId: number | null;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly baseRepositoryId: number;
}

export interface GitHubCommentSnapshot {
  readonly id: number;
  readonly body: string;
  readonly authorId: number | null;
}

export interface GitHubChecksSnapshot {
  readonly totalCount: number;
  readonly statusCount: number;
  readonly checkRuns: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
  readonly combinedState: string;
  readonly statuses: readonly {
    readonly context: string;
    readonly state: string;
    readonly description: string;
  }[];
}

export interface GitHubIssueStateUpdate {
  readonly state: "open" | "closed";
  readonly stateReason?: "completed" | "not_planned" | "reopened";
}

export interface GitHubPullUpdate {
  readonly title?: string;
  readonly body?: string;
  readonly state?: "open" | "closed";
  readonly maintainerCanModify?: boolean;
}

export interface GitHubToolBackend {
  getRepository(
    target: GitHubRepositoryTarget,
    control: GitHubBackendRequestControl,
  ): Promise<GitHubRepositorySnapshot>;
  getIssue(
    target: GitHubIssueTarget,
    control: GitHubBackendRequestControl,
  ): Promise<GitHubIssueSnapshot>;
  setLabels(
    target: GitHubIssueTarget,
    labels: readonly string[],
    control: GitHubBackendRequestControl,
  ): Promise<void>;
  setAssignees(
    target: GitHubIssueTarget,
    assignees: readonly string[],
    control: GitHubBackendRequestControl,
  ): Promise<void>;
  updateIssueState(
    target: GitHubIssueTarget,
    input: GitHubIssueStateUpdate,
    control: GitHubBackendRequestControl,
  ): Promise<void>;
  listRecentComments(
    target: GitHubIssueTarget,
    control: GitHubBackendRequestControl,
  ): Promise<readonly GitHubCommentSnapshot[]>;
  createComment(
    target: GitHubIssueTarget,
    body: string,
    control: GitHubBackendRequestControl,
  ): Promise<void>;
  getPull(
    target: GitHubPullTarget,
    control: GitHubBackendRequestControl,
  ): Promise<GitHubPullSnapshot>;
  updatePull(
    target: GitHubPullTarget,
    input: GitHubPullUpdate,
    control: GitHubBackendRequestControl,
  ): Promise<void>;
  readChecks(
    target: GitHubCommitTarget,
    control: GitHubBackendRequestControl,
  ): Promise<GitHubChecksSnapshot>;
}
