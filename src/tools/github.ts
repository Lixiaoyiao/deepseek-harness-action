/** Static Controller catalog and authorization intersection for `github.*` tools. */
export { githubToolManifest, resolveGitHubTools } from "./github-catalog.js";
export type { GitHubToolBinding } from "./github-catalog.js";

/**
 * Stateful authority boundary for deferred GitHub effects.
 *
 * `GitHubToolProvider` remains a compatibility name for existing internal and
 * downstream imports; new code should use `GitHubAuthorityGateway`.
 */
export {
  GitHubAuthorityGateway,
  GitHubAuthorityGateway as GitHubToolProvider,
  GitHubToolFlushError,
  githubFlushHasExternalEffect,
  mergeGitHubFlushReceipts,
} from "./github-authority-gateway.js";
export type {
  GitHubAuthorityGatewayOptions,
  GitHubAuthorityGatewayOptions as GitHubToolProviderOptions,
  GitHubMutationToolId,
  GitHubMutationValidationGate,
  GitHubMutationValidationRequest,
  GitHubToolFlushReceipt,
} from "./github-authority-gateway.js";
