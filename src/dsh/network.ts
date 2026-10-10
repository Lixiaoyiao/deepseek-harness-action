import { isIP } from "node:net";

import { dockerControllerEnvironment } from "./docker-policy.js";
import { DshIsolationUnavailableError } from "./errors.js";
import type { DshProcessSpec } from "./process.js";

export function dockerNetworkSpec(
  action: "create" | "remove",
  name: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
): DshProcessSpec {
  const controllerEnv = dockerControllerEnvironment(environment, {});
  return {
    command: "docker",
    args: action === "create" ? ["network", "create", "--internal", name] : ["network", "rm", name],
    cwd: workspace,
    env: controllerEnv,
  };
}

export function dockerNetworkInspectSpec(
  name: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
): DshProcessSpec {
  return {
    command: "docker",
    args: ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", name],
    cwd: workspace,
    env: dockerControllerEnvironment(environment, {}),
  };
}

export function parseInternalNetworkGateway(stdout: string): string {
  const gateway = stdout.trim();
  const firstOctet = Number(gateway.split(".")[0]);
  if (isIP(gateway) !== 4 || firstOctet === 0 || firstOctet === 127 || firstOctet >= 224) {
    throw new DshIsolationUnavailableError(
      "Docker did not report a valid IPv4 gateway for the worker network; wildcard, loopback and multicast addresses are forbidden",
    );
  }
  return gateway;
}
