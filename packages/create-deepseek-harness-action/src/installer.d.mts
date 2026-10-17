import type { Readable, Writable } from "node:stream";
import type { ProcessOptions, ProcessResult } from "./process.mjs";

export type InstallerMode = "review" | "commands" | "both" | "session";
export type InstallerDshMode = "controlled" | "native";

export interface InstallerOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly input?: Readable & { readonly isTTY?: boolean };
  readonly output?: Writable & { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly templateDirectory?: string;
  readonly processRunner?: (
    command: string,
    args: readonly string[],
    options?: ProcessOptions,
  ) => Promise<ProcessResult>;
  readonly prompter?: {
    question(message: string): Promise<string>;
    secret(message: string): Promise<string>;
    close(): void;
  };
}

export interface InstallerResult {
  readonly mode?: InstallerMode;
  readonly dshMode: InstallerDshMode;
  readonly createdFiles: readonly string[];
  readonly onboarding?: {
    repository: string;
    root: string;
    secret: string;
    committed: boolean;
    pushed: boolean;
  };
}

export function parseArguments(argv: readonly string[]): {
  readonly help: boolean;
  readonly mode: InstallerMode | undefined;
  readonly dshMode: InstallerDshMode | undefined;
  readonly testCommands?: readonly (readonly string[])[];
  readonly containerImage?: string;
  readonly advanced?: boolean;
  readonly importPlugins?: boolean;
  readonly dshHome?: string;
};

export function runInstaller(options?: InstallerOptions): Promise<InstallerResult>;
