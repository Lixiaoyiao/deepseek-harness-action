/*
 * Derived in part from anthropics/claude-code-action, MIT licensed.
 * See THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";
import { EventRoutingError } from "../errors.js";
import {
  automationEventNames,
  entityEventNames,
  isSupportedEventName,
  type SemanticEventName,
  type SupportedEventName,
} from "./events.js";

const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().min(3),
  default_branch: z.string().min(1).optional(),
  owner: z.object({ login: z.string().min(1) }),
});

const senderSchema = z.object({ login: z.string().min(1) }).optional();

const basePayloadSchema = z.looseObject({
  action: z.string().optional(),
  repository: repositorySchema,
  sender: senderSchema,
});

const issueSchema = z.object({
  number: z.number().int().positive(),
  pull_request: z.unknown().optional(),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  draft: z.boolean().optional(),
  head: z.object({
    sha: z.string().min(1),
    ref: z.string().min(1),
    repo: z.object({ id: z.number().int().positive(), full_name: z.string().min(3) }).nullable(),
  }),
  base: z.object({
    sha: z.string().min(1),
    ref: z.string().min(1),
    repo: z.object({ id: z.number().int().positive(), full_name: z.string().min(3) }),
  }),
});

const workflowRunSchema = z.object({
  id: z.number().int().positive(),
  head_sha: z.string().min(1),
  actor: z
    .object({ login: z.string().min(1) })
    .nullable()
    .optional(),
  triggering_actor: z
    .object({ login: z.string().min(1) })
    .nullable()
    .optional(),
  pull_requests: z
    .array(z.object({ number: z.number().int().positive() }))
    .optional()
    .default([]),
});

export interface RepositoryContext {
  readonly id: number;
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly defaultBranch?: string;
}

interface BaseGitHubContext {
  readonly rawEventName: SupportedEventName;
  readonly eventName: SemanticEventName;
  readonly eventAction?: string;
  readonly runId: string;
  readonly actor: string;
  readonly repository: RepositoryContext;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly isPullRequestTarget: boolean;
}

export interface EntityGitHubContext extends BaseGitHubContext {
  readonly kind: "entity";
  readonly entityNumber: number;
  readonly isPullRequest: boolean;
  readonly pullRequest?: {
    readonly number: number;
    readonly draft: boolean;
    readonly headSha: string;
    readonly headRef: string;
    readonly headRepository: string | null;
    readonly headRepositoryId: number | null;
    readonly baseSha: string;
    readonly baseRef: string;
    readonly baseRepository: string;
    readonly baseRepositoryId: number;
    readonly isFork: boolean;
  };
}

export interface AutomationGitHubContext extends BaseGitHubContext {
  readonly kind: "automation";
  readonly workflowRun?: {
    readonly id: number;
    readonly headSha: string;
    readonly actor?: string;
    readonly triggeringActor?: string;
    readonly pullRequestNumbers: readonly number[];
  };
}

export type GitHubContext = EntityGitHubContext | AutomationGitHubContext;

export interface GitHubEnvironment {
  readonly GITHUB_EVENT_NAME?: string;
  readonly GITHUB_ACTOR?: string;
  readonly GITHUB_RUN_ID?: string;
  readonly GITHUB_REPOSITORY?: string;
}

function includesEvent(events: readonly string[], eventName: string): boolean {
  return events.includes(eventName);
}

function parseRepository(
  payload: z.infer<typeof basePayloadSchema>,
  environment: GitHubEnvironment,
): RepositoryContext {
  const fullName = environment.GITHUB_REPOSITORY ?? payload.repository.full_name;
  const [owner, repo, ...extra] = fullName.split("/");
  if (!owner || !repo || extra.length > 0) {
    throw new EventRoutingError(`Invalid GITHUB_REPOSITORY: ${fullName}`);
  }
  if (
    owner.toLowerCase() !== payload.repository.owner.login.toLowerCase() ||
    repo.toLowerCase() !== payload.repository.name.toLowerCase()
  ) {
    throw new EventRoutingError(
      "GitHub environment repository does not match event payload repository",
    );
  }
  return {
    id: payload.repository.id,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    ...(payload.repository.default_branch === undefined
      ? {}
      : { defaultBranch: payload.repository.default_branch }),
  };
}

function parsePullRequest(payload: z.infer<typeof basePayloadSchema>) {
  const parsed = pullRequestSchema.safeParse(payload.pull_request);
  if (!parsed.success) {
    throw new EventRoutingError(`Invalid pull request payload: ${z.prettifyError(parsed.error)}`);
  }
  const pr = parsed.data;
  return {
    number: pr.number,
    draft: pr.draft ?? false,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    headRepository: pr.head.repo?.full_name ?? null,
    headRepositoryId: pr.head.repo?.id ?? null,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref,
    baseRepository: pr.base.repo.full_name,
    baseRepositoryId: pr.base.repo.id,
    isFork: pr.head.repo?.id !== pr.base.repo.id,
  } as const;
}

/** Parse an event snapshot while preserving the raw pull_request_target trust signal. */
export function parseGitHubContext(
  environment: GitHubEnvironment,
  untrustedPayload: unknown,
): GitHubContext {
  const rawEventName = environment.GITHUB_EVENT_NAME ?? "";
  if (!isSupportedEventName(rawEventName)) {
    throw new EventRoutingError(`Unsupported GitHub event: ${rawEventName || "<missing>"}`);
  }
  const parsed = basePayloadSchema.safeParse(untrustedPayload);
  if (!parsed.success) {
    throw new EventRoutingError(`Invalid GitHub event payload: ${z.prettifyError(parsed.error)}`);
  }
  const payload = parsed.data;
  const actor = environment.GITHUB_ACTOR ?? payload.sender?.login;
  if (!actor) throw new EventRoutingError("GitHub actor is missing");
  const repository = parseRepository(payload, environment);
  const eventName: SemanticEventName =
    rawEventName === "pull_request_target" ? "pull_request" : rawEventName;
  const common = {
    rawEventName,
    eventName,
    ...(payload.action === undefined ? {} : { eventAction: payload.action }),
    runId: environment.GITHUB_RUN_ID ?? "",
    actor,
    repository,
    payload,
    isPullRequestTarget: rawEventName === "pull_request_target",
  } as const;

  if (includesEvent(entityEventNames, rawEventName)) {
    if (rawEventName === "issues" || rawEventName === "issue_comment") {
      const issue = issueSchema.safeParse(payload.issue);
      if (!issue.success) {
        throw new EventRoutingError(`Invalid issue payload: ${z.prettifyError(issue.error)}`);
      }
      return {
        ...common,
        kind: "entity",
        entityNumber: issue.data.number,
        isPullRequest: rawEventName === "issue_comment" && issue.data.pull_request !== undefined,
      };
    }

    const pullRequest = parsePullRequest(payload);
    return {
      ...common,
      kind: "entity",
      entityNumber: pullRequest.number,
      isPullRequest: true,
      pullRequest,
    };
  }

  if (!includesEvent(automationEventNames, rawEventName)) {
    throw new EventRoutingError(`Unsupported GitHub event: ${rawEventName}`);
  }
  if (rawEventName === "workflow_run") {
    const run = workflowRunSchema.safeParse(payload.workflow_run);
    if (!run.success) {
      throw new EventRoutingError(`Invalid workflow_run payload: ${z.prettifyError(run.error)}`);
    }
    return {
      ...common,
      kind: "automation",
      workflowRun: {
        id: run.data.id,
        headSha: run.data.head_sha,
        ...(run.data.actor?.login === undefined ? {} : { actor: run.data.actor.login }),
        ...(run.data.triggering_actor?.login === undefined
          ? {}
          : { triggeringActor: run.data.triggering_actor.login }),
        pullRequestNumbers: run.data.pull_requests.map(({ number }) => number),
      },
    };
  }
  return { ...common, kind: "automation" };
}

export function isEntityContext(context: GitHubContext): context is EntityGitHubContext {
  return context.kind === "entity";
}

export function isWorkflowRunContext(context: GitHubContext): context is AutomationGitHubContext & {
  workflowRun: NonNullable<AutomationGitHubContext["workflowRun"]>;
} {
  return (
    context.kind === "automation" &&
    context.rawEventName === "workflow_run" &&
    context.workflowRun !== undefined
  );
}
