import type { ActionInputs } from "../inputs.js";
import {
  runDsh,
  type DshIsolationReport,
  type DshRunResult,
  type DshRuntime,
} from "../dsh/runner.js";
import type { DshOutput } from "../dsh/schema.js";
import type { Operation, RequestedAccess } from "../commands/parse.js";
import type { SecurityPolicy } from "../security/policy.js";
import type { EffectiveTools } from "../tools/registry.js";
import type { AgentEngine, AgentToolManifest, AgentTurnRequest } from "../agent/contracts.js";
import { workspaceToolSchema, type WorkspaceToolId } from "../tools/schema.js";

export interface AgentTask {
  readonly operation: Operation;
  readonly requestedAccess: RequestedAccess;
  readonly policy: SecurityPolicy;
  readonly contextPacket: unknown;
  readonly instructions: string;
  readonly workspacePath: string;
  readonly tools: EffectiveTools;
}

export interface RunAgentTaskOptions {
  readonly timeoutMs?: number;
  readonly runtime?: DshRuntime;
}

export interface DshTurnMetadata {
  readonly isolationReport: DshIsolationReport;
  readonly rawStdout?: string;
}

export function partitionDshToolPlanes(tools: readonly AgentToolManifest[]): {
  readonly workspaceTools: readonly WorkspaceToolId[];
  readonly controllerTools: readonly AgentToolManifest[];
} {
  const workspaceTools: WorkspaceToolId[] = [];
  const controllerTools: AgentToolManifest[] = [];
  for (const tool of tools) {
    if (tool.provider !== "builtin") {
      controllerTools.push(tool);
      continue;
    }
    const parsed = workspaceToolSchema.safeParse(tool.id);
    if (!parsed.success) throw new Error(`Unsupported native DSH tool id: ${tool.id}`);
    workspaceTools.push(parsed.data);
  }
  return { workspaceTools, controllerTools };
}

/** Current engine adapter; the outer loop depends only on the provider-neutral contract. */
export class DshAgentEngine implements AgentEngine<DshOutput, DshTurnMetadata> {
  public readonly id = "dsh";
  public readonly version: string;

  public constructor(
    private readonly inputs: ActionInputs,
    private readonly policy: SecurityPolicy,
    private readonly runtime?: DshRuntime,
  ) {
    this.version = inputs.dshVersion;
  }

  public async runTurn(request: AgentTurnRequest) {
    const { workspaceTools, controllerTools } = partitionDshToolPlanes(request.tools);
    const result = await runDsh(
      {
        operation: request.operation,
        prompt: JSON.stringify(request.context),
        trustedInstructions: request.instructions,
        workspacePath: request.workspacePath,
        toolCatalog: controllerTools,
        workspaceTools,
        trust: this.policy.trust,
        isolation: this.inputs.isolation,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
        apiKey: this.inputs.deepseekApiKey,
        baseUrl: this.inputs.baseUrl,
        dshVersion: this.inputs.dshVersion,
        ...(this.inputs.dshExecutable === "" ? {} : { dshExecutable: this.inputs.dshExecutable }),
        containerImage: this.inputs.containerImage,
      },
      this.runtime === undefined ? {} : { runtime: this.runtime },
    );
    return {
      output: result.output,
      durationMs: result.durationMs,
      metadata: {
        isolationReport: result.isolationReport,
        ...(result.rawStdout === undefined ? {} : { rawStdout: result.rawStdout }),
      },
    };
  }
}

export async function runAgentTask(
  task: AgentTask,
  inputs: ActionInputs,
  options: RunAgentTaskOptions = {},
): Promise<DshRunResult> {
  const turn = await new DshAgentEngine(inputs, task.policy, options.runtime).runTurn({
    schemaVersion: 1,
    operation: task.operation,
    requestedAccess: task.requestedAccess,
    instructions: task.instructions,
    context: task.contextPacket,
    tools: task.tools.manifests,
    workspacePath: task.workspacePath,
    timeoutMs: options.timeoutMs ?? inputs.timeoutMinutes * 60_000,
  });
  return {
    output: turn.output,
    durationMs: turn.durationMs,
    isolationReport: turn.metadata.isolationReport,
    ...(turn.metadata.rawStdout === undefined ? {} : { rawStdout: turn.metadata.rawStdout }),
  };
}
