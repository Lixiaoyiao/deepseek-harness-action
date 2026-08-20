import { z } from "zod";

export const operationSchema = z.enum(["task", "review", "diagnose", "fix", "implement"]);
export type Operation = z.infer<typeof operationSchema>;
export type RequestedAccess = "read" | "write";

export interface ParsedCommand {
  readonly operation: Operation;
  readonly instructions: string;
  readonly requestedAccess: RequestedAccess;
}

/**
 * Parse an exact first-line @dsh command plus its remaining comment body. This
 * parser is deliberately never applied to repository files, issue bodies, or
 * quoted text.
 */
export function parseCommand(content: string): ParsedCommand | null {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const firstLine = lines[0] ?? "";
  if (lines.slice(1).some((line) => /^\s*@dsh\b/iu.test(line))) return null;
  const match = /^\s*@dsh\s+(task|review|diagnose|fix|implement)(?:\s+(.*?))?\s*$/iu.exec(
    firstLine,
  );
  if (!match) return null;
  const operation = operationSchema.parse(match[1]?.toLowerCase());
  let firstInstructions = match[2]?.trim() ?? "";
  let requestedAccess: RequestedAccess =
    operation === "fix" || operation === "implement" ? "write" : "read";
  if (operation === "task") {
    const access = /^--(read|write)(?:\s+|$)/iu.exec(firstInstructions);
    if (access !== null) {
      requestedAccess = access[1]?.toLowerCase() === "write" ? "write" : "read";
      firstInstructions = firstInstructions.slice(access[0].length).trim();
    } else if (firstInstructions.startsWith("--")) {
      return null;
    }
  }
  const instructions = [firstInstructions, ...lines.slice(1)].join("\n").trim();
  if (operation === "task" && instructions === "") return null;
  return { operation, instructions, requestedAccess };
}
