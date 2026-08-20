import { randomUUID } from "node:crypto";

import type { AgentToolResult } from "../agent/contracts.js";
import { assertPinnedContainerImage } from "../dsh/runner.js";
import { runCommand, type CommandResult } from "../security/argv.js";
import type { CommandToolDefinition, CommandToolId } from "./schema.js";

function hostUserForContainer(): string {
  return process.platform === "win32"
    ? "0:0"
    : `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
}

export interface CommandToolExecution {
  readonly callId: string;
  readonly id: CommandToolId;
  readonly definition: CommandToolDefinition;
  readonly workspacePath: string;
  readonly containerImage: string;
  readonly timeoutMs: number;
}

export type CommandToolProcessRunner = (
  options: Parameters<typeof runCommand>[0],
) => Promise<CommandResult>;

/** Run one exact maintainer-owned argv in a credential-free hardened container. */
export async function executeCommandTool(
  execution: CommandToolExecution,
  processRunner: CommandToolProcessRunner = runCommand,
): Promise<AgentToolResult> {
  assertPinnedContainerImage(execution.containerImage);
  const timeoutMs = Math.min(execution.timeoutMs, execution.definition.timeoutMinutes * 60_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Command tool has no remaining execution time");
  }
  const containerName = `dsh-action-tool-${randomUUID()}`;
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    containerName,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--user",
    hostUserForContainer(),
    "--network",
    execution.definition.network,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=536870912",
    "--tmpfs",
    "/dsh-tool-home:rw,nosuid,nodev,size=268435456",
    "--mount",
    `type=bind,source=${execution.workspacePath},target=/workspace${execution.definition.workspaceAccess === "read" ? ",readonly" : ""}`,
    "--workdir",
    "/workspace",
    "--env",
    "CI=true",
    "--env",
    "HOME=/dsh-tool-home",
    execution.containerImage,
    ...execution.definition.argv,
  ];
  const cleanup = async (): Promise<void> => {
    try {
      await processRunner({
        command: "docker",
        args: ["rm", "--force", containerName],
        cwd: execution.workspacePath,
        env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
        timeoutMs: Math.min(10_000, timeoutMs),
        maxOutputBytes: 16 * 1024,
      });
    } catch {
      // The random --rm container may already be gone. Cleanup is best effort.
    }
  };
  let result: CommandResult;
  try {
    result = await processRunner({
      command: "docker",
      args,
      cwd: execution.workspacePath,
      env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
      timeoutMs,
      maxOutputBytes: execution.definition.maxOutputBytes,
    });
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }
  if (result.timedOut || result.exitCode !== 0) await cleanup();
  return {
    callId: execution.callId,
    id: execution.id,
    ok: result.exitCode === 0 && !result.timedOut,
    output: {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      truncated: result.outputTruncated,
    },
  };
}
