import * as core from "@actions/core";

import { reportFailure, runAction } from "./orchestrator.js";

async function main(): Promise<void> {
  try {
    const result = await runAction();
    core.setOutput("conclusion", result.conclusion);
    core.setOutput("operation", result.operation ?? "none");
    core.setOutput("review-summary", result.summary);
    core.setOutput("findings-count", result.findingsCount);
    core.setOutput("branch-name", result.branchName ?? "");
    core.setOutput("pull-request-url", result.pullRequestUrl ?? "");
    await core.summary
      .addHeading("DeepSeek Harness for GitHub")
      .addRaw(result.summary)
      .addEOL()
      .addRaw(`Operation: ${result.operation ?? "none"}; findings: ${String(result.findingsCount)}`)
      .write();
  } catch (error: unknown) {
    core.setOutput("conclusion", "failure");
    core.setFailed(reportFailure(error));
  }
}

await main();
