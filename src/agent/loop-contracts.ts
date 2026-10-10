import type { AgentEngine, ToolProvider } from "./contracts.js";
import type { DshRunResult, DshRuntime } from "../dsh/runner.js";
import type { DshFailureTelemetry } from "../dsh/errors.js";
import type { DshOutput } from "../dsh/schema.js";
import type { DshTurnMetadata } from "../review/run.js";
import type { ValidationFailureError } from "../write/validate.js";

export interface AgentLoopStats {
  readonly turns: number;
  readonly toolCalls: number;
  readonly validationRetries: number;
  readonly toolReceipts: readonly AgentToolReceipt[];
}

export interface AgentToolReceipt {
  readonly callId: string;
  readonly id: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly timedOut?: boolean;
  readonly error?: boolean;
  readonly effect?: "read" | "scheduled" | "created" | "updated" | "unchanged";
  readonly target?: string;
  readonly attempts?: number;
  readonly reconciled?: boolean;
  readonly externalEffect?: "possible" | "confirmed";
}

export interface AgentLoopResult<TFinal = undefined> {
  readonly agent: DshRunResult;
  readonly stats: AgentLoopStats;
  readonly finalization: TFinal;
}

export interface AgentLoopHooks<TFinal> {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly toolProvider?: ToolProvider;
  readonly blocked: (result: DshRunResult, remainingMs: number) => Promise<TFinal>;
  readonly finalize: (result: DshRunResult, remainingMs: number) => Promise<TFinal>;
  readonly onTurn?: (turn: number, maxTurns: number) => void | Promise<void>;
  /** Controller-only import, before the first official Headless worker starts. */
  readonly onRuntimeReady?: (runtime: DshRuntime) => Promise<void>;
  /** Called after successful validation/publication, before private runtime disposal. */
  readonly onRuntimeCompleted?: (
    runtime: DshRuntime,
    result: AgentLoopResult<TFinal>,
  ) => Promise<void>;
  readonly onValidationRetry?: (
    turn: number,
    error: ValidationFailureError,
  ) => void | Promise<void>;
  readonly onState?: (agent: DshRunResult, stats: AgentLoopStats) => void | Promise<void>;
  readonly onEngineFailure?: (
    failure: DshFailureTelemetry,
    stats: AgentLoopStats,
  ) => void | Promise<void>;
  readonly onCleanupError?: (
    component: "tool-provider" | "engine" | "runtime",
    error: unknown,
  ) => void | Promise<void>;
  readonly redact?: (value: string) => string;
}

export interface AgentLoopDependencies {
  readonly now?: () => number;
  readonly createRuntime?: () => Promise<DshRuntime>;
  readonly disposeRuntime?: (runtime: DshRuntime) => Promise<void>;
  readonly createEngine?: (
    runtime: DshRuntime,
  ) => AgentEngine<DshOutput, DshTurnMetadata> | Promise<AgentEngine<DshOutput, DshTurnMetadata>>;
  readonly workspaceFingerprint?: (root: string) => Promise<string>;
}
