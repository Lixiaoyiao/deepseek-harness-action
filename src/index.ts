import * as core from "@actions/core";

import { runAction } from "./orchestrator.js";
import { installCancellationHandlers } from "./lifecycle/cancellation.js";
import {
  buildActionOutputs,
  describeActionFailure,
  formatStepSummary,
  type RunOutcome,
} from "./result.js";

async function writeStepSummary(result: RunOutcome): Promise<void> {
  try {
    await core.summary
      .addHeading("DeepSeek Harness for GitHub")
      .addRaw(formatStepSummary(result))
      .write();
  } catch {
    // A summary is secondary UX. It must never turn an already-completed
    // review or trusted write into a failed/retried mutation.
    core.warning("The GitHub Actions step summary could not be published.");
  }
}

async function main(): Promise<void> {
  const cancellation = installCancellationHandlers();
  let result: RunOutcome;
  try {
    result = await runAction({ signal: cancellation.signal });
  } catch (error: unknown) {
    const failure = describeActionFailure(error, "entrypoint");
    result = {
      schemaVersion: 1,
      conclusion: "failure",
      summary: failure.title,
      findingsCount: 0,
      durationMs: 0,
      error: failure,
    };
  } finally {
    cancellation.dispose();
  }

  for (const [name, value] of Object.entries(buildActionOutputs(result))) {
    core.setOutput(name, value);
  }
  await writeStepSummary(result);
  if (result.conclusion === "failure") {
    core.setFailed(result.error?.message ?? result.summary);
  }
}

await main();
// The Controller has awaited publication, outputs, summaries, and cleanup.
// Exit explicitly so an abandoned HTTP socket or third-party runtime handle
// cannot keep a completed Action alive beyond timeout-minutes.
process.exit(process.exitCode ?? 0);
