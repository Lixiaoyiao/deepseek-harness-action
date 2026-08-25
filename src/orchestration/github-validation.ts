import { AgentDeadlineError } from "../agent/loop.js";
import type { ActionInputs } from "../inputs.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";
import { PolicyDeniedError } from "../errors.js";
import type { GitHubMutationValidationGate } from "../tools/github-authority-gateway.js";
import {
  enforceValidationIntegrity,
  inspectValidationIntegrity,
} from "../write/validation-integrity.js";
import {
  remainingValidationMs,
  withinValidationDeadline,
  type ValidationDeadline,
} from "../write/validation-deadline.js";
import {
  assertValidationSucceeded,
  assertWriteValidationConfigured,
  runValidationCommandsInDocker,
} from "../write/validate.js";
import {
  fingerprintWorkspace,
  inspectWorkspaceChanges,
  type WorkspaceSnapshot,
} from "../write/workspace.js";
import type { RunState } from "./lifecycle.js";

/** Controller validation for the exact workspace revision behind deferred GitHub mutations. */
export class ControllerGitHubMutationValidation {
  private fingerprint: string | undefined;
  private budget: ValidationDeadline | undefined;

  public constructor(
    private readonly options: {
      readonly state: RunState;
      readonly workspace: WorkspaceSnapshot;
      readonly inputs: ActionInputs;
      readonly deadlineMs: number;
      readonly signal: AbortSignal;
    },
  ) {}

  public readonly gate: GitHubMutationValidationGate = async () => {
    await this.validate();
  };

  /** Validate before the first Agent turn as well as immediately before a queued flush. */
  public async validate(): Promise<void> {
    const { state, workspace, inputs, deadlineMs, signal } = this.options;
    assertWriteValidationConfigured(inputs.runTests, inputs.testCommands);
    const before = await fingerprintWorkspace(workspace.workerRoot);
    if (before === this.fingerprint) return;
    state.phase = "validation";
    if (this.budget === undefined) {
      const phaseMs = phaseTimeoutMs(deadlineMs, PHASE_TIMEOUTS.validationMs, Date.now);
      if (phaseMs <= 0) throw new AgentDeadlineError();
      this.budget = { deadlineMs: Date.now() + phaseMs, signal };
    }
    const budget = this.budget;
    const changes = await withinValidationDeadline(
      async () => inspectWorkspaceChanges(workspace),
      budget,
    );
    let integrity = await withinValidationDeadline(
      async () =>
        inspectValidationIntegrity({
          snapshot: workspace,
          changes,
          commands: inputs.testCommands,
          mode: inputs.validationIntegrity,
        }),
      budget,
    );
    integrity = await withinValidationDeadline(
      async () =>
        enforceValidationIntegrity({
          snapshot: workspace,
          commands: inputs.testCommands,
          audit: integrity,
          baselineReplay: {
            containerImage: inputs.containerImage,
            timeoutMs: remainingValidationMs(budget),
            signal,
          },
        }),
      budget,
    );
    state.validationIntegrity = integrity;
    const validationResults = await withinValidationDeadline(
      async () =>
        runValidationCommandsInDocker(
          workspace.workerRoot,
          inputs.testCommands,
          inputs.containerImage,
          remainingValidationMs(budget),
          undefined,
          signal,
        ),
      budget,
    );
    assertValidationSucceeded(validationResults);
    state.validationPassed = true;
    const after = await fingerprintWorkspace(workspace.workerRoot);
    if (after !== before) {
      throw new PolicyDeniedError(
        "Workspace changed while validating deferred GitHub mutations; refusing mutation",
      );
    }
    this.fingerprint = after;
  }

  /** Existing Controller write validation authorizes this exact new revision. */
  public async acceptValidatedWorkspaceRevision(): Promise<void> {
    this.fingerprint = await fingerprintWorkspace(this.options.workspace.workerRoot);
  }
}
