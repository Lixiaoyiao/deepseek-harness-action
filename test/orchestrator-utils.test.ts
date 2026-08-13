import { describe, expect, it } from "vitest";

import { assertOperationContext, boundedText, reportFailure } from "../src/orchestrator.js";
import type { EntitySnapshot } from "../src/github/fetch.js";
import type { GitHubContext } from "../src/github/context.js";

describe("orchestrator bounds and failure reporting", () => {
  it("bounds UTF-8 without splitting multibyte characters", () => {
    expect(boundedText("small", 10)).toBe("small");
    const bounded = boundedText("路径".repeat(100), 64);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(64);
    expect(bounded.endsWith("[truncated by dsh-action]")).toBe(true);
    expect(bounded).not.toContain("�");
  });

  it("redacts controller secrets and caps reported failures", () => {
    const secret = `ghp_${"a".repeat(36)}`;
    const message = reportFailure(new Error(`failure ${secret} ${"x".repeat(5_000)}`));
    expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(message.length).toBeLessThanOrEqual(4_000);
  });

  it("rejects operation/entity mismatches before DSH execution", () => {
    const context = {
      kind: "entity",
      rawEventName: "issues",
      eventName: "issues",
      eventAction: "opened",
      runId: "1",
      actor: "maintainer",
      repository: { id: 1, owner: "o", repo: "r", fullName: "o/r" },
      payload: {},
      isPullRequestTarget: false,
      entityNumber: 1,
      isPullRequest: false,
    } satisfies GitHubContext;
    const issue = { kind: "issue" } as EntitySnapshot;
    const pullRequest = { kind: "pull_request" } as EntitySnapshot;

    expect(() =>
      assertOperationContext(
        { operation: "review", source: "mention", instructions: "" },
        context,
        issue,
      ),
    ).toThrow("only on pull requests");
    expect(() =>
      assertOperationContext(
        { operation: "fix", source: "mention", instructions: "" },
        context,
        issue,
      ),
    ).toThrow("only on pull requests");
    expect(() =>
      assertOperationContext(
        { operation: "implement", source: "mention", instructions: "" },
        context,
        pullRequest,
      ),
    ).toThrow("only on issues");
    expect(() =>
      assertOperationContext(
        { operation: "diagnose", source: "mention", instructions: "" },
        context,
        issue,
      ),
    ).toThrow("requires a pull request or workflow_run");
  });
});
