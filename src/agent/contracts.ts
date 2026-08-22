import type { Operation, RequestedAccess } from "../commands/parse.js";

export const AGENT_PROTOCOL_VERSION = 1 as const;

export interface AgentToolManifest {
  readonly id: string;
  readonly description: string;
  readonly provider: "builtin" | "command" | "mcp" | "plugin";
  readonly permissions: readonly ("read" | "write" | "execute" | "network")[];
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface AgentToolCall {
  /** Controller-generated idempotency key; model output never chooses it. */
  readonly callId: string;
  readonly id: string;
  readonly input: unknown;
}

export interface AgentToolResult {
  readonly callId: string;
  readonly id: string;
  readonly ok: boolean;
  readonly output: unknown;
}

export interface AgentSessionBinding {
  readonly schemaVersion: 1;
  readonly repositoryId: number;
  readonly target: string;
  readonly headSha: string;
  readonly actorFingerprint: string;
  readonly policyFingerprint: string;
  readonly taskScopeFingerprint: string;
  readonly operation: Operation;
  readonly requestedAccess: RequestedAccess;
  readonly engine: { readonly id: string; readonly version: string };
  readonly toolsetDigest: string;
  readonly extensionLock: readonly {
    readonly id: string;
    readonly version: string;
    readonly digest: string;
    readonly source: "builtin" | "mcp" | "plugin";
  }[];
}

export interface AgentSessionHandle {
  readonly provider: string;
  readonly id: string;
  readonly resumeToken?: string;
  readonly revision: number;
  readonly expiresAt: string;
  readonly binding: AgentSessionBinding;
}

export interface AgentTurnRequest {
  readonly schemaVersion: 1;
  readonly operation: Operation;
  readonly requestedAccess: RequestedAccess;
  readonly instructions: string;
  readonly context: unknown;
  readonly tools: readonly AgentToolManifest[];
  readonly workspacePath: string;
  /** Immutable controller-wide deadline; setup and turns may not extend it. */
  readonly deadlineMs: number;
  /** Per-turn Agent execution cap, started only after runtime setup completes. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly session?: AgentSessionHandle;
}

export interface AgentTurnResponse<TOutput = unknown, TMetadata = unknown> {
  readonly output: TOutput;
  readonly durationMs: number;
  readonly metadata: TMetadata;
  readonly session?: AgentSessionHandle;
}

/** Provider-neutral seam implemented by the current DSH headless adapter. */
export interface AgentEngine<TOutput = unknown, TMetadata = unknown> {
  readonly id: string;
  readonly version: string;
  runTurn(request: AgentTurnRequest): Promise<AgentTurnResponse<TOutput, TMetadata>>;
  dispose?(): Promise<void>;
}

export interface ToolInvocationContext {
  readonly workspacePath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface ToolProvider {
  readonly id: string;
  manifest(): readonly AgentToolManifest[];
  invoke(call: AgentToolCall, context: ToolInvocationContext): Promise<AgentToolResult>;
  dispose?(): Promise<void>;
}

export interface SessionStore {
  load(binding: AgentSessionBinding): Promise<AgentSessionHandle | null>;
  save(session: AgentSessionHandle, expectedRevision: number | null): Promise<void>;
  invalidate(binding: AgentSessionBinding): Promise<void>;
}
