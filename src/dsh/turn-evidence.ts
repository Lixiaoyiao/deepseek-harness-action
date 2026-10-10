import { assertNoSecretOutput } from "../security/env.js";
import type { PreparedDshComposition } from "./composition.js";
import type { DshFailureTelemetry } from "./errors.js";
import {
  emptyInvocationCounts,
  fileSize,
  readInvocationCounts,
  readToolReceipts,
  reconcileToolAudit,
} from "./receipts.js";
import type { DshRunScope } from "./run-scope.js";

/** Audit a single turn; evidence errors never replace an independent primary failure. */
export class DshTurnEvidence {
  private offset = 0;
  private countsBefore = emptyInvocationCounts();
  private evidence: Pick<DshFailureTelemetry, "observedTools" | "toolReceipts"> = {};
  private readonly composition: PreparedDshComposition;
  private readonly scope: DshRunScope;
  private readonly secrets: readonly string[];

  public constructor(
    composition: PreparedDshComposition,
    scope: DshRunScope,
    secrets: readonly string[],
  ) {
    this.composition = composition;
    this.scope = scope;
    this.secrets = secrets;
  }

  public async begin(): Promise<void> {
    const receipts =
      this.composition.isolation === "docker" ? this.composition.receipts : undefined;
    if (receipts === undefined) return;
    const initial = await this.scope.setup(async () => ({
      offset: await fileSize(receipts.auditPath),
      counts: await readInvocationCounts(receipts.statePath, receipts.rules),
    }));
    this.offset = initial.offset;
    this.countsBefore = initial.counts;
  }

  public async collect(primaryFailure: unknown): Promise<unknown> {
    if (this.composition.isolation !== "docker") return primaryFailure;
    let failure = primaryFailure;
    const observation = this.composition.observedTools;
    if (observation !== undefined) {
      try {
        const observedTools = await this.scope.setup(async () => observation.collect());
        assertNoSecretOutput(
          "native tool observation",
          JSON.stringify(observedTools),
          this.secrets,
        );
        this.evidence = { ...this.evidence, observedTools };
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    const receipts = this.composition.receipts;
    if (receipts !== undefined) {
      try {
        const toolReceipts = await this.scope.setup(async () => {
          const current = await readToolReceipts(receipts.auditPath, this.offset);
          assertNoSecretOutput("tool receipt", JSON.stringify(current), this.secrets);
          reconcileToolAudit(
            this.countsBefore,
            await readInvocationCounts(receipts.statePath, receipts.rules),
            current,
            failure === undefined,
          );
          return current;
        });
        if (toolReceipts.length > 0) this.evidence = { ...this.evidence, toolReceipts };
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    return failure;
  }

  public fields(): Pick<DshFailureTelemetry, "observedTools" | "toolReceipts"> {
    return this.evidence;
  }
}
