export type DshErrorCode =
  | "DSH_ABORTED"
  | "DSH_CONFIGURATION"
  | "DSH_CREDENTIAL_LEAK"
  | "DSH_ENVIRONMENT"
  | "DSH_ISOLATION_UNAVAILABLE"
  | "DSH_MALFORMED_OUTPUT"
  | "DSH_OUTPUT_LIMIT"
  | "DSH_PROCESS_FAILED"
  | "DSH_PROXY"
  | "DSH_SPAWN"
  | "DSH_TIMEOUT";

export class DshError extends Error {
  public readonly code: DshErrorCode;

  public constructor(code: DshErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class DshConfigurationError extends DshError {
  public constructor(message: string, options?: ErrorOptions) {
    super("DSH_CONFIGURATION", message, options);
  }
}

export class DshEnvironmentError extends DshError {
  public constructor(message: string, options?: ErrorOptions) {
    super("DSH_ENVIRONMENT", message, options);
  }
}

export class DshIsolationUnavailableError extends DshError {
  public constructor(message: string, options?: ErrorOptions) {
    super("DSH_ISOLATION_UNAVAILABLE", message, options);
  }
}

export class DshSpawnError extends DshError {
  public constructor(message: string, options?: ErrorOptions) {
    super("DSH_SPAWN", message, options);
  }
}

export class DshTimeoutError extends DshError {
  public readonly timeoutMs: number;

  public constructor(timeoutMs: number) {
    super("DSH_TIMEOUT", `DSH exceeded its ${String(timeoutMs)} ms overall timeout`);
    this.timeoutMs = timeoutMs;
  }
}

export class DshAbortedError extends DshError {
  public constructor() {
    super("DSH_ABORTED", "DSH execution was aborted");
  }
}

export class DshOutputLimitError extends DshError {
  public readonly stream: "stdout" | "stderr" | "combined";
  public readonly limitBytes: number;

  public constructor(stream: "stdout" | "stderr" | "combined", limitBytes: number) {
    super(
      "DSH_OUTPUT_LIMIT",
      `DSH ${stream} exceeded the ${String(limitBytes)} byte capture limit`,
    );
    this.stream = stream;
    this.limitBytes = limitBytes;
  }
}

export class DshProcessError extends DshError {
  public readonly exitCode: number | null;
  public readonly signal: NodeJS.Signals | null;
  public readonly stderr: string;

  public constructor(exitCode: number | null, signal: NodeJS.Signals | null, stderr: string) {
    const status = signal === null ? `exit code ${String(exitCode)}` : `signal ${signal}`;
    super("DSH_PROCESS_FAILED", `DSH failed with ${status}${stderr === "" ? "" : `: ${stderr}`}`);
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderr = stderr;
  }
}

export class DshMalformedOutputError extends DshError {
  public constructor(message: string, options?: ErrorOptions) {
    super("DSH_MALFORMED_OUTPUT", message, options);
  }
}

export class DshCredentialLeakError extends DshError {
  public constructor(channel: "stdout" | "stderr") {
    super("DSH_CREDENTIAL_LEAK", `DSH ${channel} contained a controller credential`);
  }
}

export class DshProxyError extends DshError {
  public constructor(message: string, options?: ErrorOptions) {
    super("DSH_PROXY", message, options);
  }
}
