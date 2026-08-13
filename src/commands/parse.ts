import { z } from "zod";

export const operationSchema = z.enum(["review", "diagnose", "fix", "implement"]);
export type Operation = z.infer<typeof operationSchema>;

export interface ParsedCommand {
  readonly operation: Operation;
  readonly instructions: string;
}

/**
 * Parse a single line beginning with an exact @dsh command. This parser is
 * deliberately never applied to repository files, issue bodies, or quoted text.
 */
export function parseCommand(content: string): ParsedCommand | null {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const firstLine = lines[0] ?? "";
  if (lines.slice(1).some((line) => /^\s*@dsh\b/iu.test(line))) return null;
  const match = /^\s*@dsh\s+(review|diagnose|fix|implement)(?:\s+(.*?))?\s*$/iu.exec(firstLine);
  if (!match) return null;
  const operation = operationSchema.parse(match[1]?.toLowerCase());
  return { operation, instructions: match[2]?.trim() ?? "" };
}
