import type {
  AgentToolCall,
  AgentToolResult,
  ToolInvocationContext,
  ToolProvider,
} from "./contracts.js";
import type { AgentToolReceipt } from "./loop-contracts.js";
import { isRecord } from "../security/record.js";

/** Execute the external tool port and project bounded evidence on both exit paths. */
export async function invokeControllerTool(
  provider: ToolProvider,
  call: AgentToolCall,
  context: ToolInvocationContext,
  record: (receipt: AgentToolReceipt) => void,
  now: () => number,
): Promise<AgentToolResult> {
  const startedAt = now();
  let result: AgentToolResult;
  try {
    result = await provider.invoke(call, context);
  } catch (error: unknown) {
    record({
      callId: call.callId,
      id: call.id,
      ok: false,
      error: true,
      durationMs: Math.max(0, now() - startedAt),
    });
    throw error;
  }
  const output = isRecord(result.output) ? result.output : undefined;
  record({
    callId: result.callId,
    id: result.id,
    ok: result.ok,
    durationMs: Math.max(0, now() - startedAt),
    ...(typeof output?.timedOut === "boolean" ? { timedOut: output.timedOut } : {}),
    ...(output?.effect === "read" ||
    output?.effect === "scheduled" ||
    output?.effect === "created" ||
    output?.effect === "updated" ||
    output?.effect === "unchanged"
      ? { effect: output.effect }
      : {}),
    ...(typeof output?.target === "string" && Buffer.byteLength(output.target, "utf8") <= 160
      ? { target: output.target }
      : {}),
    ...(typeof output?.attempts === "number" &&
    Number.isInteger(output.attempts) &&
    output.attempts >= 0 &&
    output.attempts <= 2
      ? { attempts: output.attempts }
      : {}),
    ...(typeof output?.reconciled === "boolean" ? { reconciled: output.reconciled } : {}),
    ...(output?.externalEffect === "possible" || output?.externalEffect === "confirmed"
      ? { externalEffect: output.externalEffect }
      : {}),
  });
  return result;
}
