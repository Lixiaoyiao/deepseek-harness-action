import { describe, expect, it } from "vitest";

import {
  assertOperationContext,
  boundedText,
  deferProgressUntilWriteValidation,
  reportFailure,
} from "../src/orchestrator.js";
import type { EntitySnapshot } from "../src/github/fetch.js";
import type { GitHubContext } from "../src/github/context.js";
import { taskIdentity } from "../src/orchestration/context.js";
import { inputs } from "./helpers.js";

describe("orchestrator bounds and failure reporting", () => {
  it("defers every write-task progress publication until final validation", () => {
    expect(deferProgressUntilWriteValidation({ requestedAccess: "write" })).toBe(true);
    expect(deferProgressUntilWriteValidation({ requestedAccess: "read" })).toBe(false);
  });

  it("bounds UTF-8 without splitting multibyte characters", () => {
    expect(boundedText("small", 10)).toBe("small");
    const bounded = boundedText("路径".repeat(100), 64);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(64);
    expect(bounded.endsWith("[truncated by dsh-action]")).toBe(true);
    expect(bounded).not.toContain("�");
  });

  it("binds base and branch naming configuration into deterministic task identity", () => {
    const command = {
      operation: "task" as const,
      source: "explicit-prompt" as const,
      instructions: "update dependencies",
      requestedAccess: "write" as const,
    };
    const baseline = taskIdentity(command, inputs(), "extensions", "permissions");
    expect(taskIdentity(command, inputs(), "extensions", "permissions")).toBe(baseline);
    for (const configured of [
      inputs({ baseBranch: "release/next" }),
      inputs({ branchPrefix: "automation/" }),
      inputs({ branchNameTemplate: "{{prefix}}{{operation}}-{{key}}" }),
    ]) {
      expect(taskIdentity(command, configured, "extensions", "permissions")).not.toBe(baseline);
    }
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
        { operation: "review", source: "mention", instructions: "", requestedAccess: "read" },
        context,
        issue,
      ),
    ).toThrow("only on pull requests");
    expect(() =>
      assertOperationContext(
        { operation: "fix", source: "mention", instructions: "", requestedAccess: "write" },
        context,
        issue,
      ),
    ).toThrow("only on pull requests");
    expect(() =>
      assertOperationContext(
        {
          operation: "implement",
          source: "mention",
          instructions: "",
          requestedAccess: "write",
        },
        context,
        pullRequest,
      ),
    ).toThrow("only on issues");
    expect(() =>
      assertOperationContext(
        {
          operation: "diagnose",
          source: "mention",
          instructions: "",
          requestedAccess: "read",
        },
        context,
        issue,
      ),
    ).toThrow("requires a pull request or workflow_run");
  });

  it("never authorizes a pull-request write against the default branch", () => {
    const context = {
      kind: "entity",
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      eventAction: "created",
      runId: "1",
      actor: "maintainer",
      repository: {
        id: 1,
        owner: "o",
        repo: "r",
        fullName: "o/r",
        defaultBranch: "main",
      },
      payload: {},
      isPullRequestTarget: false,
      entityNumber: 1,
      isPullRequest: true,
    } satisfies GitHubContext;
    const pullRequest = { kind: "pull_request", headRef: "main" } as EntitySnapshot;
    expect(() =>
      assertOperationContext(
        {
          operation: "task",
          source: "mention",
          instructions: "change the code",
          requestedAccess: "write",
        },
        context,
        pullRequest,
      ),
    ).toThrow("default branch");

    expect(() =>
      assertOperationContext(
        {
          operation: "task",
          source: "mention",
          instructions: "change the code",
          requestedAccess: "write",
        },
        context,
        { kind: "pull_request", headRef: "feature" } as EntitySnapshot,
      ),
    ).not.toThrow();

    expect(() =>
      assertOperationContext(
        {
          operation: "task",
          source: "mention",
          instructions: "change the code",
          requestedAccess: "write",
        },
        context,
        { kind: "pull_request", headRef: "release/next" } as EntitySnapshot,
        "release/next",
      ),
    ).toThrow("configured base branch");
  });

  it("fails closed before every trusted write when the default branch is absent", () => {
    const automation = {
      kind: "automation",
      rawEventName: "workflow_dispatch",
      eventName: "workflow_dispatch",
      runId: "1",
      actor: "maintainer",
      repository: { id: 1, owner: "o", repo: "r", fullName: "o/r" },
      payload: {},
      isPullRequestTarget: false,
    } satisfies GitHubContext;
    expect(() =>
      assertOperationContext(
        {
          operation: "task",
          source: "explicit-prompt",
          instructions: "change the code",
          requestedAccess: "write",
        },
        automation,
        undefined,
      ),
    ).toThrow("base branch identity");

    const issueContext = {
      ...automation,
      kind: "entity",
      rawEventName: "issues",
      eventName: "issues",
      entityNumber: 7,
      isPullRequest: false,
    } satisfies GitHubContext;
    expect(() =>
      assertOperationContext(
        {
          operation: "implement",
          source: "mention",
          instructions: "implement it",
          requestedAccess: "write",
        },
        issueContext,
        { kind: "issue" } as EntitySnapshot,
      ),
    ).toThrow("base branch identity");

    expect(() =>
      assertOperationContext(
        {
          operation: "implement",
          source: "mention",
          instructions: "implement it",
          requestedAccess: "write",
        },
        issueContext,
        { kind: "issue" } as EntitySnapshot,
        "release/next",
      ),
    ).not.toThrow();
  });
});
