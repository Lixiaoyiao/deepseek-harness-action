import type { ServerResponse } from "node:http";

export function sendMessagesSse(
  response: ServerResponse,
  delta: Readonly<Record<string, unknown>>,
  finishReason: string,
): void;
export function messageToolResults(request: {
  readonly messages?: readonly { readonly content?: unknown }[] | undefined;
}): readonly { readonly type: "tool_result"; readonly content: unknown }[];
