import { tmpdir } from "node:os";
import * as core from "@actions/core";

import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PRODUCTION_DSH_COMPOSITION } from "./controlled-composition.js";
import { DshError, DshTimeoutError } from "./errors.js";
import { admitDshRun, prepareDshContext } from "./runner-context.js";
import { isolationReport, runtimeExtensionAudit } from "./runner-policy.js";
import type { DshRunDependencies, DshRunRequest, DshRunResult } from "./runner-types.js";
import { DshRunScope } from "./run-scope.js";
import { createDshRuntime, disposeDshRuntime } from "./runtime.js";
import { PHASE_TIMEOUTS } from "./timeouts.js";
import { DshWorker } from "./worker-turn.js";

export { assertSupportedDshVersion, SUPPORTED_DSH_VERSIONS } from "./version.js";
export { createDshRuntime, disposeDshRuntime } from "./runtime.js";
export type { DshRuntime } from "./runtime.js";
export { executeBoundedDshProcess } from "./process.js";
export type { DshProcessLimits, DshProcessResult, DshProcessSpec } from "./process.js";
export { assertContainerImageReference, assertPinnedContainerImage } from "./docker-policy.js";
export {
  assertExtensionPackagesDoNotShadowRuntime,
  assertInstalledRuntimeInventoryUnchanged,
  installedTopLevelPackageInventory,
} from "./install.js";
export type { DshToolReceipt } from "./receipts.js";
export type {
  DshTrust,
  DshIsolation,
  DshRunRequest,
  DshIsolationReport,
  DshRunResult,
  DshRunDependencies,
} from "./runner-types.js";

/** Admit -> bind context/runtime -> prepare/execute worker -> close the one resource scope. */
export async function runDsh(
  request: DshRunRequest,
  dependencies: DshRunDependencies = {},
): Promise<DshRunResult> {
  const composition = dependencies.composition ?? PRODUCTION_DSH_COMPOSITION.create();
  const admission = admitDshRun(request, dependencies, composition);
  throwIfCancelled(request.signal);
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = request.deadlineMs ?? startedAt + request.timeoutMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= startedAt) {
    throw new DshTimeoutError(request.timeoutMs);
  }
  const scope = new DshRunScope(
    startedAt,
    deadlineMs,
    request.timeoutMs,
    request.signal,
    now,
    dependencies.warning ?? core.warning,
  );
  const context = await prepareDshContext(admission, dependencies, scope);
  const ownsRuntime = dependencies.runtime === undefined;
  const runtime =
    dependencies.runtime ??
    (await scope.phase(
      async () => createDshRuntime(dependencies.temporaryDirectory ?? tmpdir()),
      PHASE_TIMEOUTS.runtimeCreateMs,
      disposeDshRuntime,
    ));
  if (ownsRuntime) scope.own("runtime", async () => disposeDshRuntime(runtime));
  try {
    return await new DshWorker(context, runtime, scope, dependencies).run();
  } catch (error: unknown) {
    if (error instanceof DshError) {
      const extensionAudit = runtimeExtensionAudit(
        request,
        context.extensions,
        runtime,
        composition,
      );
      error.attachTelemetry({
        ...error.telemetry,
        durationMs: Math.max(0, now() - startedAt),
        isolationReport: isolationReport(request, composition),
        ...(extensionAudit === undefined ? {} : { extensionAudit }),
      });
    }
    throw error;
  } finally {
    await scope.close();
  }
}
