import { DSH_VERSION } from "../release.js";
import { DshConfigurationError } from "./errors.js";

const DSH_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u;

export const SUPPORTED_DSH_VERSIONS = [DSH_VERSION] as const;

/** Bind policy patches to DSH versions whose complete native tool surface was audited. */
export function assertSupportedDshVersion(version: string): void {
  if (!DSH_VERSION_PATTERN.test(version)) {
    throw new DshConfigurationError("dshVersion must be an exact semver, not a tag or range");
  }
  if (!(SUPPORTED_DSH_VERSIONS as readonly string[]).includes(version)) {
    throw new DshConfigurationError(
      `dshVersion ${version} has no audited dsh-action policy profile; supported: ${SUPPORTED_DSH_VERSIONS.join(", ")}`,
    );
  }
}
