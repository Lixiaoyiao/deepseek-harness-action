import type { GitHubClient } from "../github/client.js";
import type { GitHubContext } from "../github/context.js";
import { checkActorPermissions } from "../github/permissions.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PolicyDeniedError } from "../errors.js";
import { evaluatePolicy, type SecurityPolicy } from "../security/policy.js";
import type { RoutedCommand } from "../commands/router.js";

/** Fresh authorization may revoke capability but never upgrade an admitted operation. */
export function createAuthorityRevalidator(options: {
  readonly client: GitHubClient;
  readonly context: GitHubContext;
  readonly command: RoutedCommand;
  readonly inputs: Pick<ActionInputs, "allowedBots" | "allowWrite">;
  readonly policy: SecurityPolicy;
  readonly pullRequest?: { readonly isFork: boolean };
  readonly signal: AbortSignal;
}): () => Promise<void> {
  const {
    client,
    context,
    command: admittedCommand,
    inputs,
    policy,
    pullRequest,
    signal,
  } = options;
  return async (): Promise<void> => {
    throwIfCancelled(signal);
    const currentPermissions = await checkActorPermissions(client, context, inputs.allowedBots);
    throwIfCancelled(signal);
    const currentPolicy = evaluatePolicy({
      context,
      operation: admittedCommand.operation,
      allowWrite: inputs.allowWrite,
      permissions: currentPermissions,
      requestedAccess: admittedCommand.requestedAccess,
      commandSource: admittedCommand.source,
      allowWorkflowRunWrite:
        context.rawEventName === "workflow_run" &&
        admittedCommand.operation === "fix" &&
        pullRequest !== undefined,
      ...(pullRequest === undefined ? {} : { resolvedPullRequest: { isFork: pullRequest.isFork } }),
    });
    if (
      !currentPolicy.allowed ||
      Object.entries(policy.capabilities).some(
        ([name, granted]) =>
          granted &&
          !Object.entries(currentPolicy.capabilities).some(
            ([currentName, currentGrant]) => currentName === name && currentGrant,
          ),
      )
    ) {
      throw new PolicyDeniedError(
        "Current actor authority no longer permits the admitted operation",
      );
    }
  };
}
