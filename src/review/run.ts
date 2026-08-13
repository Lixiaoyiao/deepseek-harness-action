import type { ActionInputs } from "../inputs.js";
import { runDsh, type DshRunResult } from "../dsh/runner.js";
import type { Operation } from "../commands/parse.js";
import type { SecurityPolicy } from "../security/policy.js";

export interface AgentTask {
  readonly operation: Operation;
  readonly policy: SecurityPolicy;
  readonly contextPacket: unknown;
  readonly instructions: string;
  readonly workspacePath: string;
}

export async function runAgentTask(task: AgentTask, inputs: ActionInputs): Promise<DshRunResult> {
  return runDsh({
    operation: task.operation,
    prompt: JSON.stringify(task.contextPacket),
    trustedInstructions: task.instructions,
    workspacePath: task.workspacePath,
    trust: task.policy.trust,
    isolation: inputs.isolation,
    timeoutMs: inputs.timeoutMinutes * 60_000,
    maxOutputBytes: 2 * 1024 * 1024,
    apiKey: inputs.deepseekApiKey,
    baseUrl: inputs.baseUrl,
    dshVersion: inputs.dshVersion,
    ...(inputs.dshExecutable === "" ? {} : { dshExecutable: inputs.dshExecutable }),
    containerImage: inputs.containerImage,
  });
}
