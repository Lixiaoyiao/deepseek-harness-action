import type { Operation } from "../commands/parse.js";
import type { RequestedAccess } from "../commands/parse.js";
import type { CommandSource } from "../commands/router.js";
import type { GitHubContext } from "../github/context.js";
import type { PermissionCheck } from "../github/permissions.js";

export interface Capabilities {
  readonly readRepository: boolean;
  readonly readCi: boolean;
  readonly publishComments: boolean;
  readonly executeRepositoryCode: boolean;
  readonly loadExtensions: boolean;
  readonly accessNetwork: boolean;
  readonly modifyWorkspace: boolean;
  readonly commit: boolean;
  readonly push: boolean;
  readonly createPullRequest: boolean;
}

export interface SecurityPolicy {
  readonly trust: "untrusted" | "trusted-read" | "trusted-write";
  readonly allowed: boolean;
  readonly reason: string;
  readonly capabilities: Capabilities;
}

export interface PolicyInput {
  readonly context: GitHubContext;
  readonly operation: Operation;
  readonly allowWrite: boolean;
  readonly permissions: PermissionCheck;
  /** Controller-resolved intent. A model response can never upgrade this value. */
  readonly requestedAccess?: RequestedAccess;
  /** How the operation was selected. Mentions are privileged control-plane input. */
  readonly commandSource?: CommandSource["kind"];
  /** Controller-resolved PR metadata for issue_comment events on a PR. */
  readonly resolvedPullRequest?: { readonly isFork: boolean };
  /** Explicit trusted automation opt-in after workflow_run actor validation. */
  readonly allowWorkflowRunWrite?: boolean;
}

const noCapabilities: Capabilities = {
  readRepository: false,
  readCi: false,
  publishComments: false,
  executeRepositoryCode: false,
  loadExtensions: false,
  accessNetwork: false,
  modifyWorkspace: false,
  commit: false,
  push: false,
  createPullRequest: false,
};

function sameRepositoryState(
  context: GitHubContext,
  resolvedPullRequest: PolicyInput["resolvedPullRequest"],
): "same" | "fork" | "unknown" {
  if (context.rawEventName === "workflow_run") {
    if (resolvedPullRequest === undefined) return "unknown";
    return resolvedPullRequest.isFork ? "fork" : "same";
  }
  if (context.kind !== "entity" || !context.isPullRequest) return "same";
  const pullRequest = context.pullRequest ?? resolvedPullRequest;
  if (pullRequest === undefined) return "unknown";
  return pullRequest.isFork ? "fork" : "same";
}

/** Central capability decision. Callers must never infer write trust independently. */
export function evaluatePolicy(input: PolicyInput): SecurityPolicy {
  const { context, operation, allowWrite, permissions } = input;
  const repositoryState = sameRepositoryState(context, input.resolvedPullRequest);
  const sameRepository = repositoryState === "same";
  const writeRequested =
    input.requestedAccess === "write" ||
    (input.requestedAccess === undefined && (operation === "fix" || operation === "implement"));
  const actorCanWrite = permissions.allActorsAllowedForWrite;
  const targetEvent = context.isPullRequestTarget;

  const readCapabilities: Capabilities = {
    ...noCapabilities,
    readRepository: true,
    readCi: operation === "diagnose" || operation === "fix",
    publishComments: true,
    loadExtensions: sameRepository && actorCanWrite,
    accessNetwork: sameRepository && actorCanWrite,
  };

  if (input.commandSource === "mention" && !actorCanWrite) {
    return {
      trust: "untrusted",
      allowed: false,
      reason:
        "Mention command denied because every originating actor must have trusted write access",
      capabilities: noCapabilities,
    };
  }

  if (!writeRequested) {
    return {
      trust: sameRepository && actorCanWrite ? "trusted-read" : "untrusted",
      allowed: true,
      reason:
        repositoryState === "same"
          ? "Read-only operation; repository content remains untrusted data"
          : "Unresolved or fork pull request restricted to non-executing review or diagnosis",
      capabilities: readCapabilities,
    };
  }

  if (!allowWrite) {
    return {
      trust: "untrusted",
      allowed: false,
      reason: "Write operation denied because allow-write is false",
      capabilities: noCapabilities,
    };
  }
  if (context.rawEventName === "workflow_run" && input.allowWorkflowRunWrite !== true) {
    return {
      trust: "untrusted",
      allowed: false,
      reason: "Write operation denied for workflow_run without an explicit trusted auto-fix route",
      capabilities: noCapabilities,
    };
  }
  if (repositoryState === "unknown") {
    return {
      trust: "untrusted",
      allowed: false,
      reason: "Write operation denied until the controller resolves pull request origin",
      capabilities: noCapabilities,
    };
  }
  if (!sameRepository || targetEvent) {
    return {
      trust: "untrusted",
      allowed: false,
      reason: "Write operation denied for fork or pull_request_target context",
      capabilities: noCapabilities,
    };
  }
  if (!actorCanWrite) {
    return {
      trust: "untrusted",
      allowed: false,
      reason:
        "Write operation denied because every originating actor must have trusted write access",
      capabilities: noCapabilities,
    };
  }

  return {
    trust: "trusted-write",
    allowed: true,
    reason: "Explicit write opt-in, same-repository context, and trusted actor checks passed",
    capabilities: {
      readRepository: true,
      readCi: operation === "fix",
      publishComments: true,
      executeRepositoryCode: true,
      loadExtensions: true,
      accessNetwork: true,
      modifyWorkspace: true,
      commit: true,
      push: true,
      createPullRequest:
        operation === "implement" ||
        (operation === "task" && !(context.kind === "entity" && context.isPullRequest)),
    },
  };
}
