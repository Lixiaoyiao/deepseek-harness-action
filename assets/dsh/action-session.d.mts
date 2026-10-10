export const name: "dsh-action-session";

export interface SessionPlan {
  readonly schemaVersion: 1;
  readonly bindingDigest: string;
  readonly permissionMode: "read-only" | "workspace-write";
  readonly workingDirectory: string;
  readonly sessionId?: string;
  readonly checkpointEventCount?: number;
}

export interface SessionAdmissionAgent {
  readonly session: {
    readonly id: string;
    seq: number;
    readonly firstLiveSeq: number;
    readonly header: {
      readonly cwd: string;
      readonly origin?: "subagent";
      readonly parentSession?: string;
    };
  };
  readonly inbox: { readonly nextTurn: readonly unknown[]; readonly nextStep: readonly unknown[] };
}

export type SessionCreatedListener = (payload: {
  agent: SessionAdmissionAgent;
  source: string;
}) => void;
export type SessionRequestListener = (
  payload: { agent: SessionAdmissionAgent },
  next: () => Promise<unknown>,
) => Promise<unknown>;
export type SessionAdmissionGuard = (execution: {
  agent?: SessionAdmissionAgent;
}) => string | undefined;
export type SessionAdmissionRegistration =
  | [event: "agent/created", listener: SessionCreatedListener, options?: { prepend?: boolean }]
  | [event: "agent/request", listener: SessionRequestListener, options?: { prepend?: boolean }];

/** The Cordis service/event surface used by the admission plugin. */
export interface SessionAdmissionContext {
  get(name: string): unknown;
  on(...registration: SessionAdmissionRegistration): void;
  inject(
    names: string[],
    setup: (scope: { tools: { guard(callback: SessionAdmissionGuard): void } }) => void,
  ): void;
}

export function validateSessionPlan(value: unknown): SessionPlan;
export function readSessionPlan(path: string, home: string): SessionPlan;
export function sessionHeadlessPatch(
  value: unknown,
  task: string,
): {
  readonly id: "headless-runner";
  readonly config: { readonly task: string; readonly json: true; readonly sessionId?: string };
};
export function installSessionAdmission(
  ctx: SessionAdmissionContext,
  rawPlan: unknown,
  options?: { auditPath?: string },
): void;
export function apply(ctx: SessionAdmissionContext, config: unknown): void;
