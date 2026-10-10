import { mergeModelUsage, type ModelUsage } from "../dsh/usage.js";
import type { DshRunResult, DshToolReceipt } from "../dsh/runner.js";
import type { DshFailureTelemetry } from "../dsh/errors.js";
import type { AgentLoopStats, AgentToolReceipt } from "./loop-contracts.js";

/** One owner accumulates evidence across turns, including the final failed turn. */
export class LoopTelemetry {
  private durationMs = 0;
  private usage: ModelUsage | undefined;
  private incompleteUsage = false;
  private validationRetries = 0;
  private readonly dshReceipts: DshToolReceipt[] = [];
  private readonly tools = new Set<string>();
  private readonly controllerReceipts: AgentToolReceipt[] = [];

  public observe(result: DshRunResult): DshRunResult;
  public observe(result: DshFailureTelemetry): DshFailureTelemetry;
  public observe(result: DshRunResult | DshFailureTelemetry): DshRunResult | DshFailureTelemetry {
    this.durationMs += result.durationMs;
    if (result.usage === undefined) this.incompleteUsage = true;
    else
      this.usage =
        this.usage === undefined ? result.usage : mergeModelUsage(this.usage, result.usage);
    this.dshReceipts.push(...(result.toolReceipts ?? []));
    for (const name of result.observedTools ?? []) this.tools.add(name);
    return {
      ...result,
      durationMs: this.durationMs,
      ...(this.usage === undefined
        ? {}
        : {
            usage: this.incompleteUsage ? { ...this.usage, completeness: "partial" } : this.usage,
          }),
      ...(this.dshReceipts.length === 0 ? {} : { toolReceipts: [...this.dshReceipts] }),
      ...(this.tools.size === 0 ? {} : { observedTools: [...this.tools].sort() }),
    };
  }

  public recordTool(receipt: AgentToolReceipt): void {
    this.controllerReceipts.push(receipt);
  }

  public recordValidationRetry(): void {
    this.validationRetries += 1;
  }

  public stats(turns: number): AgentLoopStats {
    return {
      turns,
      toolCalls: this.controllerReceipts.length,
      validationRetries: this.validationRetries,
      toolReceipts: [...this.controllerReceipts],
    };
  }
}
