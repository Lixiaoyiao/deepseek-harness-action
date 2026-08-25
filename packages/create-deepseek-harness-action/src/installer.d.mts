import type { Readable, Writable } from "node:stream";

export type InstallerMode = "review" | "commands" | "both";
export type InstallerDshMode = "controlled" | "native";

export interface InstallerOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  readonly input?: Readable & { readonly isTTY?: boolean };
  readonly output?: Writable & { readonly isTTY?: boolean };
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY?: boolean;
  readonly templateDirectory?: string;
}

export interface InstallerResult {
  readonly mode?: InstallerMode;
  readonly dshMode: InstallerDshMode;
  readonly createdFiles: readonly string[];
}

export function parseArguments(argv: readonly string[]): {
  readonly help: boolean;
  readonly mode: InstallerMode | undefined;
  readonly dshMode: InstallerDshMode | undefined;
};

export function runInstaller(options?: InstallerOptions): Promise<InstallerResult>;
