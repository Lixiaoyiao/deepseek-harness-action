import type { ActionStatus, RunOutcome } from "./types.js";

export function actionStatus(outcome: RunOutcome): ActionStatus {
  if (outcome.conclusion !== "failure") return outcome.conclusion;
  if (outcome.error?.category === "policy" || outcome.error?.code === "POLICY_DENIED") {
    return "denied";
  }
  if (outcome.error?.code === "DSH_TIMEOUT" || outcome.error?.code === "AGENT_TIMEOUT") {
    return "timed_out";
  }
  if (
    outcome.error?.code === "DSH_MALFORMED_OUTPUT" ||
    outcome.error?.code.startsWith("VALIDATION_") === true
  ) {
    return "validation_failed";
  }
  // Preserve phase-based compatibility only for otherwise-unclassified errors.
  if (outcome.error?.category === undefined && outcome.error?.phase === "validation") {
    return "validation_failed";
  }
  return "failed";
}
