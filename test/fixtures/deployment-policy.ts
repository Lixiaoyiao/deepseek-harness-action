export type DeploymentRole = "admin" | "maintainer" | "viewer";

export function canDeployProduction(role: DeploymentRole): boolean {
  return role === "admin" || role === "maintainer";
}
