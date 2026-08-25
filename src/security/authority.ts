import { extensionCredentialOwnerFacts } from "../extensions/credentials.js";
import type { ExtensionPlan } from "../extensions/plan.js";

export type ControllerAuthoritySource =
  | {
      readonly kind: "controller-credential";
      readonly service: "github";
      readonly holder: "controller";
      readonly credentialExposure: "not-exposed-to-worker";
    }
  | {
      readonly kind: "controller-credential";
      readonly service: "deepseek";
      readonly holder: "controller";
      readonly credentialExposure: "not-exposed-to-worker";
      readonly mediation: "run-scoped-proxy";
    };

export interface ExtensionAuthoritySource {
  readonly kind: "extension-credential";
  readonly extensionKind: "mcp" | "plugin";
  readonly extensionId: string;
  readonly provisionedBy: "workflow";
  readonly configuredFor: "worker-extension";
}

export type KnownAuthoritySource = ControllerAuthoritySource | ExtensionAuthoritySource;

export interface AuthorityAudit {
  readonly schemaVersion: 1;
  readonly scope: "action-known-sources";
  readonly knownSources: readonly KnownAuthoritySource[];
}

const controllerSources: readonly ControllerAuthoritySource[] = Object.freeze([
  Object.freeze({
    kind: "controller-credential",
    service: "github",
    holder: "controller",
    credentialExposure: "not-exposed-to-worker",
  }),
  Object.freeze({
    kind: "controller-credential",
    service: "deepseek",
    holder: "controller",
    credentialExposure: "not-exposed-to-worker",
    mediation: "run-scoped-proxy",
  }),
]);

function compareExtensionSources(
  left: ExtensionAuthoritySource,
  right: ExtensionAuthoritySource,
): number {
  if (left.extensionKind !== right.extensionKind) {
    return left.extensionKind < right.extensionKind ? -1 : 1;
  }
  if (left.extensionId === right.extensionId) return 0;
  return left.extensionId < right.extensionId ? -1 : 1;
}

function extensionCredentialSources(
  extensions: ExtensionPlan | undefined,
): readonly ExtensionAuthoritySource[] {
  return extensionCredentialOwnerFacts(extensions)
    .map<ExtensionAuthoritySource>((owner) => ({
      kind: "extension-credential",
      extensionKind: owner.extensionKind,
      extensionId: owner.extensionId,
      provisionedBy: "workflow",
      configuredFor: "worker-extension",
    }))
    .sort(compareExtensionSources);
}

/** Build a value-only audit of Action-known authority sources without credential material. */
export function buildAuthorityAudit(extensions?: ExtensionPlan): AuthorityAudit {
  return {
    schemaVersion: 1,
    scope: "action-known-sources",
    knownSources: [...controllerSources, ...extensionCredentialSources(extensions)],
  };
}
