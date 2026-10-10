import type { AgentToolReceipt } from "../agent/loop.js";
import type { DshToolReceipt } from "../dsh/runner.js";
import type { RunOutcome } from "./types.js";
import { actionStatus } from "./status.js";

interface PublicReceiptPayload {
  readonly controller: readonly AgentToolReceipt[];
  readonly dsh: readonly DshToolReceipt[];
  readonly truncated: boolean;
  readonly droppedCount: number;
}

const MAX_LARGE_ACTION_OUTPUT_UTF16_BYTES = 640 * 1024;

function structuredResult(
  outcome: RunOutcome,
  receipts: PublicReceiptPayload,
): Record<string, unknown> {
  const write = {
    ...(outcome.writeStatus === undefined ? {} : { status: outcome.writeStatus }),
    ...(outcome.commitSha === undefined ? {} : { commitSha: outcome.commitSha }),
    ...(outcome.changedPaths === undefined ? {} : { changedPaths: outcome.changedPaths }),
    ...(outcome.branchName === undefined ? {} : { branchName: outcome.branchName }),
    ...(outcome.pullRequestNumber === undefined
      ? {}
      : { pullRequestNumber: outcome.pullRequestNumber }),
    ...(outcome.pullRequestUrl === undefined ? {} : { pullRequestUrl: outcome.pullRequestUrl }),
  };
  return {
    schemaVersion: outcome.schemaVersion,
    status: actionStatus(outcome),
    conclusion: outcome.conclusion,
    operation: outcome.operation ?? "none",
    summary: outcome.summary,
    findingsCount: outcome.findingsCount,
    timing: {
      durationMs: outcome.durationMs,
      ...(outcome.agent === undefined ? {} : { agentDurationMs: outcome.agent.durationMs }),
    },
    ...(outcome.runUrl === undefined ? {} : { run: { url: outcome.runUrl } }),
    ...(outcome.policy === undefined
      ? {}
      : {
          policy: {
            trust: outcome.policy.trust,
            allowed: outcome.policy.allowed,
            reason: outcome.policy.reason,
            capabilities: outcome.policy.capabilities,
          },
        }),
    ...(outcome.permission === undefined ? {} : { permissions: outcome.permission }),
    ...(outcome.toolPolicy === undefined ? {} : { toolPolicy: outcome.toolPolicy }),
    ...(outcome.dsh === undefined ? {} : { dsh: outcome.dsh }),
    ...(outcome.authority === undefined ? {} : { authority: outcome.authority }),
    ...(outcome.agent === undefined
      ? {}
      : {
          isolation: outcome.agent.isolation,
          loop: {
            ...(outcome.agent.turns === undefined ? {} : { turns: outcome.agent.turns }),
            ...(outcome.agent.toolCalls === undefined
              ? {}
              : { toolCalls: outcome.agent.toolCalls }),
            ...(outcome.agent.validationRetries === undefined
              ? {}
              : { validationRetries: outcome.agent.validationRetries }),
            ...(receipts.controller.length === 0 ? {} : { toolReceipts: receipts.controller }),
            ...(receipts.dsh.length === 0 ? {} : { dshToolReceipts: receipts.dsh }),
            ...(receipts.truncated
              ? {
                  toolReceiptsTruncated: true,
                  toolReceiptsDroppedCount: receipts.droppedCount,
                }
              : {}),
          },
          ...(outcome.agent.extensionAudit === undefined
            ? {}
            : { extensions: outcome.agent.extensionAudit }),
        }),
    ...(outcome.agent?.usage === undefined ? {} : { modelUsage: outcome.agent.usage }),
    ...(outcome.publication === undefined ? {} : { publication: outcome.publication }),
    ...(outcome.validation === undefined ? {} : { validation: outcome.validation }),
    ...(Object.keys(write).length === 0 ? {} : { write }),
    ...(outcome.commentId === undefined ? {} : { commentId: outcome.commentId }),
    ...(outcome.taskOutput === undefined ? {} : { taskOutput: outcome.taskOutput }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
    ...(outcome.githubRequests === undefined ? {} : { githubRequests: outcome.githubRequests }),
    ...(outcome.session === undefined ? {} : { session: outcome.session }),
    ...(outcome.textSources === undefined ? {} : { textSources: outcome.textSources }),
  };
}

type InterleavedReceipt =
  | { readonly plane: "controller"; readonly receipt: AgentToolReceipt }
  | { readonly plane: "dsh"; readonly receipt: DshToolReceipt };

function interleavedReceipts(outcome: RunOutcome): readonly InterleavedReceipt[] {
  const controller = outcome.agent?.toolReceipts ?? [];
  const dsh = outcome.agent?.dshToolReceipts ?? [];
  const entries: InterleavedReceipt[] = [];
  for (let index = 0; index < Math.max(controller.length, dsh.length); index += 1) {
    const controllerReceipt = controller[index];
    if (controllerReceipt !== undefined) {
      entries.push({ plane: "controller", receipt: controllerReceipt });
    }
    const dshReceipt = dsh[index];
    if (dshReceipt !== undefined) entries.push({ plane: "dsh", receipt: dshReceipt });
  }
  return entries;
}

function receiptPayload(
  entries: ReturnType<typeof interleavedReceipts>,
  keep: number,
): PublicReceiptPayload {
  const controller: AgentToolReceipt[] = [];
  const dsh: DshToolReceipt[] = [];
  for (const entry of entries.slice(0, keep)) {
    if (entry.plane === "controller") controller.push(entry.receipt);
    else dsh.push(entry.receipt);
  }
  return {
    controller,
    dsh,
    truncated: keep < entries.length,
    droppedCount: entries.length - keep,
  };
}

function utf16Bytes(value: string): number {
  return value.length * 2;
}

function boundedPublicReceipts(outcome: RunOutcome): PublicReceiptPayload {
  const entries = interleavedReceipts(outcome);
  const serializedBytes = (keep: number): number => {
    const receipts = receiptPayload(entries, keep);
    return (
      utf16Bytes(JSON.stringify(receipts)) +
      utf16Bytes(JSON.stringify(structuredResult(outcome, receipts)))
    );
  };
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(middle) <= MAX_LARGE_ACTION_OUTPUT_UTF16_BYTES) low = middle;
    else high = middle - 1;
  }
  return receiptPayload(entries, low);
}

export function buildActionOutputs(outcome: RunOutcome): Readonly<Record<string, string | number>> {
  const receipts = boundedPublicReceipts(outcome);
  return {
    conclusion: outcome.conclusion,
    operation: outcome.operation ?? "none",
    summary: outcome.summary,
    "review-summary": outcome.summary,
    "dsh-mode": outcome.dsh?.mode ?? "none",
    "dsh-composition": outcome.dsh?.composition ?? "none",
    "findings-count": outcome.findingsCount,
    "branch-name": outcome.branchName ?? "",
    "pull-request-url": outcome.pullRequestUrl ?? "",
    "commit-sha": outcome.commitSha ?? "",
    trust: outcome.policy?.trust ?? "none",
    "duration-ms": outcome.durationMs,
    "comment-id": outcome.commentId ?? "",
    "task-output": outcome.taskOutput === undefined ? "" : JSON.stringify(outcome.taskOutput),
    "error-code": outcome.error?.code ?? "",
    "error-message": outcome.error?.message ?? "",
    "extension-profile-digest": outcome.agent?.extensionAudit?.digest ?? "",
    "permission-profile": outcome.permission?.profile ?? "none",
    "effective-tools": JSON.stringify(outcome.permission?.effectiveTools ?? []),
    "network-access": outcome.permission?.network ?? "none",
    "workspace-write": outcome.permission?.workspaceWrite === true ? "true" : "false",
    "trusted-extensions": JSON.stringify(outcome.permission?.trustedExtensions ?? []),
    "tool-receipts": JSON.stringify(receipts),
    "result-json": JSON.stringify(structuredResult(outcome, receipts)),
  };
}
