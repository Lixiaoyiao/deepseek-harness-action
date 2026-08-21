import { isAbsolute, resolve } from "node:path";

export const name = "dsh-action-workspace";

export function apply(ctx, config) {
  if (
    typeof config !== "object" ||
    config === null ||
    typeof config.cwd !== "string" ||
    !isAbsolute(config.cwd)
  ) {
    throw new Error("dsh-action-workspace: cwd must be an absolute path");
  }
  const cwd = resolve(config.cwd);
  process.chdir(cwd);
  ctx.provide("actionWorkspace", Object.freeze({ cwd }));
}
