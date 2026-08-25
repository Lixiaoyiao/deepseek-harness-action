import { createHash } from "node:crypto";

import type { DshProcessSpec } from "./process.js";
import type { DshComposition } from "./composition.js";
import type { DshRuntime } from "./runtime.js";
import { DshConfigurationError } from "./errors.js";
import {
  configuredMcpDefinitionSecrets,
  configuredPluginDefinitionSecrets,
  emptyNativeExtensionPlan,
  type AnyExtensionAudit,
  type ExtensionAudit,
  type ExtensionPlan,
} from "../extensions/plan.js";
import { assertNoSecretOutput, collectControllerSecrets } from "../security/env.js";
import type { NativeToolId } from "../tools/schema.js";
import type { DshIsolationReport, DshRunRequest } from "./runner.js";

const EMPTY_EXTENSION_AUDIT_DIGEST = createHash("sha256")
  .update(
    '{"entries":[],"network":false,"packageDependencies":{},"profile":"github-action","schemaVersion":1}',
    "utf8",
  )
  .digest("hex");
const EMPTY_EXTENSION_CONFIGURATION_DIGEST = createHash("sha256")
  .update(
    '{"bundles":[],"mcpServers":[],"packageDependencies":{},"plugins":[],"profile":"github-action","schemaVersion":1}',
    "utf8",
  )
  .digest("hex");

export function effectiveExtensionPlan(
  request: DshRunRequest,
  composition: DshComposition,
): ExtensionPlan {
  if (request.extensions !== undefined) return request.extensions;
  if (composition.extensionPlanProfile === "headless-native") return emptyNativeExtensionPlan();
  const audit: ExtensionAudit = {
    schemaVersion: 1,
    profile: "github-action",
    digest: EMPTY_EXTENSION_AUDIT_DIGEST,
    network: false,
    entries: [],
  };
  return {
    schemaVersion: 1,
    profileName: "github-action",
    digest: EMPTY_EXTENSION_AUDIT_DIGEST,
    configurationDigest: EMPTY_EXTENSION_CONFIGURATION_DIGEST,
    network: false,
    mcpServers: [],
    bundles: [],
    plugins: [],
    tools: [],
    manifests: [],
    packageDependencies: {},
    audit,
  };
}

function defaultNativeTools(request: DshRunRequest): readonly NativeToolId[] {
  if (request.trust === "trusted-write") {
    return ["workspace.read", "workspace.search", "workspace.edit"];
  }
  if (request.trust === "trusted-read" && request.isolation === "docker") {
    return ["workspace.read", "workspace.search"];
  }
  return [];
}

export function effectiveNativeTools(request: DshRunRequest): readonly NativeToolId[] {
  const requested = request.nativeTools ?? defaultNativeTools(request);
  if (request.trust === "untrusted") return [];
  if (request.trust === "trusted-read" && request.isolation !== "docker") return [];
  return requested.filter(
    (tool) =>
      request.isolation === "docker" &&
      (request.trust === "trusted-write" ||
        (tool !== "workspace.edit" && tool !== "native.bash" && tool !== "native.subagent")),
  );
}

export function workerWorkspaceWrite(request: DshRunRequest, composition: DshComposition): boolean {
  if (composition.toolPolicyOwner === "dsh") return request.trust === "trusted-write";
  const plan = effectiveExtensionPlan(request, composition);
  if (plan.profileName !== "github-action") {
    throw new DshConfigurationError(
      "Controlled workspace authority requires a github-action extension plan",
    );
  }
  return (
    effectiveNativeTools(request).includes("workspace.edit") ||
    plan.tools.some((tool) => tool.permissions.includes("workspace-write"))
  );
}

export function isolationReport(
  request: DshRunRequest,
  composition: DshComposition,
): DshIsolationReport {
  const nativeTools = effectiveNativeTools(request);
  const plan = effectiveExtensionPlan(request, composition);
  const metadata = composition.isolationMetadata({
    isolation: request.isolation,
    nativeTools,
    extensionNetwork: plan.network,
    extensionsConfigured: plan.mcpServers.length + plan.bundles.length + plan.plugins.length > 0,
  });
  if (request.isolation === "docker") {
    return {
      backend: "docker",
      credentialMediated: true,
      repoToolsEnabled: metadata.repoToolsEnabled,
      processIsolated: true,
      networkIsolated: !plan.network,
      workspaceAccess: workerWorkspaceWrite(request, composition) ? "read-write" : "read-only",
      extensionProfile: metadata.extensionProfile,
      ...(composition.actionManagedExtensionProfile || plan.audit.entries.length > 0
        ? { extensionDigest: plan.digest }
        : {}),
      limitations: metadata.limitations,
    };
  }
  return {
    backend: "none",
    credentialMediated: true,
    repoToolsEnabled: metadata.repoToolsEnabled,
    processIsolated: false,
    networkIsolated: false,
    workspaceAccess: workerWorkspaceWrite(request, composition) ? "read-write" : "read-only",
    extensionProfile: metadata.extensionProfile,
    limitations: metadata.limitations,
  };
}

export function withheldControllerSecrets(
  request: DshRunRequest,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  return [
    ...new Set([
      request.apiKey,
      ...(request.controllerCredentials ?? []),
      ...collectControllerSecrets(environment),
    ]),
  ].filter((secret) => secret.length >= 4);
}

export function extensionSecrets(extensions: ExtensionPlan): readonly string[] {
  return [
    ...new Set([
      ...extensions.mcpServers.flatMap(({ definition }) =>
        configuredMcpDefinitionSecrets(definition),
      ),
      ...extensions.plugins.flatMap(({ definition }) =>
        configuredPluginDefinitionSecrets(definition),
      ),
    ]),
  ];
}

export function assertWorkerLaunchHasNoControllerCredentials(
  spec: DshProcessSpec,
  secrets: readonly string[],
): void {
  assertNoSecretOutput("argv", [spec.command, ...spec.args].join("\u0000"), secrets);
  assertNoSecretOutput(
    "environment",
    Object.entries(spec.env)
      .map(([name, value]) => `${name}=${value ?? ""}`)
      .join("\u0000"),
    secrets,
  );
}

export function runtimeExtensionAudit(
  request: DshRunRequest,
  extensions: ExtensionPlan,
  runtime: DshRuntime,
  composition: DshComposition,
): AnyExtensionAudit | undefined {
  if (request.isolation !== "docker") return undefined;
  if (!composition.actionManagedExtensionProfile && extensions.audit.entries.length === 0) {
    return undefined;
  }
  return runtime.installedExtensionRuntimeLock === undefined
    ? extensions.audit
    : { ...extensions.audit, runtimeLock: runtime.installedExtensionRuntimeLock };
}
