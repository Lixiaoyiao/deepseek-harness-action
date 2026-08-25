import type { ActionInputs } from "../inputs.js";
import {
  runDsh,
  type DshIsolationReport,
  type DshRunResult,
  type DshRuntime,
  type DshToolReceipt,
} from "../dsh/runner.js";
import type { DshOutput } from "../dsh/schema.js";
import type { Operation, RequestedAccess } from "../commands/parse.js";
import type { SecurityPolicy } from "../security/policy.js";
import { removeMarkdownImages } from "../security/redaction.js";
import type { EffectiveTools } from "../tools/registry.js";
import type { AgentEngine, AgentToolManifest, AgentTurnRequest } from "../agent/contracts.js";
import type { AnyExtensionAudit, ExtensionPlan } from "../extensions/plan.js";
import { nativeToolSchema, type NativeToolId } from "../tools/schema.js";
import type { DshComposition } from "../dsh/composition.js";
import { selectDshComposition } from "../dsh/select-composition.js";

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
  readonly signal?: AbortSignal;
}

export interface DshTurnMetadata {
  readonly isolationReport: DshIsolationReport;
  readonly rawStdout?: string;
  readonly extensionAudit?: AnyExtensionAudit;
  readonly toolReceipts?: readonly DshToolReceipt[];
  readonly observedTools?: readonly string[];
}

export function partitionDshToolPlanes(tools: readonly AgentToolManifest[]): {
  readonly nativeTools: readonly NativeToolId[];
  readonly controllerTools: readonly AgentToolManifest[];
  readonly extensionTools: readonly AgentToolManifest[];
} {
  const nativeTools: NativeToolId[] = [];
  const controllerTools: AgentToolManifest[] = [];
  const extensionTools: AgentToolManifest[] = [];
  for (const tool of tools) {
    if (tool.provider === "command" || tool.provider === "github") {
      controllerTools.push(tool);
      continue;
    }
    if (tool.provider === "mcp" || tool.provider === "plugin") {
      extensionTools.push(tool);
      continue;
    }
    const parsed = nativeToolSchema.safeParse(tool.id);
    if (!parsed.success) throw new Error(`Unsupported native DSH tool id: ${tool.id}`);
    nativeTools.push(parsed.data);
  }
  return { nativeTools, controllerTools, extensionTools };
}

/** Current engine adapter; the outer loop depends only on the provider-neutral contract. */
export class DshAgentEngine implements AgentEngine<DshOutput, DshTurnMetadata> {
  public readonly id = "dsh";
  public readonly version: string;
  private readonly composition: DshComposition;

  public constructor(
    private readonly inputs: ActionInputs,
    private readonly policy: SecurityPolicy,
    private readonly runtime?: DshRuntime,
    private readonly extensions?: ExtensionPlan,
    composition?: DshComposition,
  ) {
    this.version = inputs.dshVersion;
    this.composition = composition ?? selectDshComposition(inputs.dshMode).create();
  }

  public async runTurn(request: AgentTurnRequest) {
    const { nativeTools, controllerTools, extensionTools } = partitionDshToolPlanes(request.tools);
    const actualExtensionIds = extensionTools.map(({ id }) => id).sort();
    if (this.extensions?.profileName === "github-action") {
      const plannedExtensionIds = this.extensions.manifests.map(({ id }) => id).sort();
      if (JSON.stringify(actualExtensionIds) !== JSON.stringify(plannedExtensionIds)) {
        throw new Error("DSH extension manifest set does not match the Controller plan");
      }
    } else if (actualExtensionIds.length > 0) {
      throw new Error("Native DSH extensions must not be represented as Controller manifests");
    }
    const result = await runDsh(
      {
        operation: request.operation,
        prompt: JSON.stringify(request.context, (_key, value: unknown) =>
          typeof value === "string" ? removeMarkdownImages(value) : value,
        ),
        trustedInstructions: removeMarkdownImages(request.instructions),
        workspacePath: request.workspacePath,
        toolCatalog: controllerTools,
        nativeTools,
        ...(request.operation !== "task" || this.inputs.taskOutputSchema === undefined
          ? {}
          : { taskOutputSchema: this.inputs.taskOutputSchema }),
        ...(this.extensions === undefined ? {} : { extensions: this.extensions }),
        trust: this.policy.trust,
        isolation: this.inputs.isolation,
        deadlineMs: request.deadlineMs,
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        maxOutputBytes: 2 * 1024 * 1024,
        apiKey: this.inputs.deepseekApiKey,
        controllerCredentials: [this.inputs.githubToken],
        baseUrl: this.inputs.baseUrl,
        webSearchBaseUrl: this.inputs.webSearchBaseUrl,
        dshVersion: this.inputs.dshVersion,
        ...(this.inputs.dshExecutable === "" ? {} : { dshExecutable: this.inputs.dshExecutable }),
        containerImage: this.inputs.containerImage,
      },
      {
        composition: this.composition,
        ...(this.runtime === undefined ? {} : { runtime: this.runtime }),
      },
    );
    return {
      output: result.output,
      durationMs: result.durationMs,
      metadata: {
        isolationReport: result.isolationReport,
        ...(result.rawStdout === undefined ? {} : { rawStdout: result.rawStdout }),
        ...(result.extensionAudit === undefined ? {} : { extensionAudit: result.extensionAudit }),
        ...(result.toolReceipts === undefined ? {} : { toolReceipts: result.toolReceipts }),
        ...(result.observedTools === undefined ? {} : { observedTools: result.observedTools }),
      },
    };
  }
}

export async function runAgentTask(
  task: AgentTask,
  inputs: ActionInputs,
  options: RunAgentTaskOptions = {},
): Promise<DshRunResult> {
  const timeoutMs = options.timeoutMs ?? inputs.timeoutMinutes * 60_000;
  const turn = await new DshAgentEngine(
    inputs,
    task.policy,
    options.runtime,
    task.tools.extensions,
  ).runTurn({
    schemaVersion: 1,
    operation: task.operation,
    requestedAccess: task.requestedAccess,
    instructions: task.instructions,
    context: task.contextPacket,
    tools: task.tools.manifests,
    workspacePath: task.workspacePath,
    deadlineMs: Date.now() + timeoutMs,
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    output: turn.output,
    durationMs: turn.durationMs,
    isolationReport: turn.metadata.isolationReport,
    ...(turn.metadata.rawStdout === undefined ? {} : { rawStdout: turn.metadata.rawStdout }),
    ...(turn.metadata.extensionAudit === undefined
      ? {}
      : { extensionAudit: turn.metadata.extensionAudit }),
    ...(turn.metadata.toolReceipts === undefined
      ? {}
      : { toolReceipts: turn.metadata.toolReceipts }),
    ...(turn.metadata.observedTools === undefined
      ? {}
      : { observedTools: turn.metadata.observedTools }),
  };
}
