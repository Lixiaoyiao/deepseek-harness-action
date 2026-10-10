import type { Context } from "@deepseek-ai/cordis";

export const name: "dsh-action-policy";
export const inject: readonly ["tools", "systemPrompt"];
/** Installs the Action-owned policy after validating rawConfig. */
export function apply(ctx: Context, rawConfig: unknown): void;
