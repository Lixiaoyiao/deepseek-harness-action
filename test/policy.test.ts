import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/security/policy.js";
import { permissions, pullRequestContext } from "./helpers.js";

describe("evaluatePolicy", () => {
  it("permits fork review without repository code execution", () => {
    const policy = evaluatePolicy({
      context: pullRequestContext({ fork: true }),
      operation: "review",
      allowWrite: true,
      permissions: permissions(false),
    });
    expect(policy.allowed).toBe(true);
    expect(policy.trust).toBe("untrusted");
    expect(policy.capabilities.publishComments).toBe(true);
    expect(policy.capabilities.executeRepositoryCode).toBe(false);
    expect(policy.capabilities.modifyWorkspace).toBe(false);
    expect(policy.capabilities.manageIssueLabels).toBe(false);
    expect(policy.capabilities.updatePullRequestMetadata).toBe(false);
  });

  it("denies mention commands from actors without write permission", () => {
    const policy = evaluatePolicy({
      context: pullRequestContext({ fork: true }),
      operation: "review",
      allowWrite: false,
      permissions: permissions(false),
      commandSource: "mention",
    });
    expect(policy).toMatchObject({ allowed: false, trust: "untrusted" });
    expect(policy.reason).toContain("Mention command");
    expect(policy.capabilities.publishComments).toBe(false);
  });

  it("still permits automatic fork review from an unprivileged PR actor", () => {
    const policy = evaluatePolicy({
      context: pullRequestContext({ fork: true }),
      operation: "review",
      allowWrite: false,
      permissions: permissions(false),
      commandSource: "automatic-event",
    });
    expect(policy).toMatchObject({ allowed: true, trust: "untrusted" });
    expect(policy.capabilities.publishComments).toBe(true);
    expect(policy.capabilities.executeRepositoryCode).toBe(false);
  });

  it("allows only read/search for a trusted same-repo pull_request_target review", () => {
    const base = pullRequestContext();
    const policy = evaluatePolicy({
      context: {
        ...base,
        rawEventName: "pull_request_target",
        isPullRequestTarget: true,
      },
      operation: "review",
      allowWrite: true,
      permissions: permissions(true),
      commandSource: "automatic-event",
    });
    expect(policy).toMatchObject({ allowed: true, trust: "trusted-read" });
    expect(policy.capabilities).toMatchObject({
      readRepository: true,
      executeRepositoryCode: false,
      modifyWorkspace: false,
      commit: false,
      push: false,
    });
  });

  it.each([
    [false, false, true, "allow-write"],
    [true, true, true, "fork"],
    [true, false, false, "actor"],
  ])(
    "denies fix when allowWrite=%s fork=%s actorWrite=%s",
    (allowWrite, fork, actorWrite, reason) => {
      const policy = evaluatePolicy({
        context: pullRequestContext({ fork }),
        operation: "fix",
        allowWrite,
        permissions: permissions(actorWrite),
      });
      expect(policy.allowed).toBe(false);
      expect(policy.reason.toLowerCase()).toContain(reason);
      expect(policy.capabilities.push).toBe(false);
    },
  );

  it("enables the full write path only after every gate passes", () => {
    const policy = evaluatePolicy({
      context: pullRequestContext(),
      operation: "implement",
      allowWrite: true,
      permissions: permissions(true),
    });
    expect(policy.trust).toBe("trusted-write");
    expect(policy.capabilities).toMatchObject({
      executeRepositoryCode: true,
      commit: true,
      push: true,
      createPullRequest: true,
      manageIssueLabels: true,
      manageIssueAssignees: true,
      updateIssueState: true,
      updatePullRequestMetadata: true,
    });
  });

  it("keeps task access controller-owned and grants PR creation only to trusted writes", () => {
    const base = pullRequestContext();
    const automation = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_dispatch" as const,
      eventName: "workflow_dispatch" as const,
    };
    const read = evaluatePolicy({
      context: automation,
      operation: "task",
      requestedAccess: "read",
      allowWrite: false,
      permissions: permissions(true),
      commandSource: "explicit-prompt",
    });
    const write = evaluatePolicy({
      context: automation,
      operation: "task",
      requestedAccess: "write",
      allowWrite: true,
      permissions: permissions(true),
      commandSource: "explicit-prompt",
    });
    const deniedTarget = evaluatePolicy({
      context: {
        ...pullRequestContext(),
        rawEventName: "pull_request_target",
        isPullRequestTarget: true,
      },
      operation: "task",
      requestedAccess: "write",
      allowWrite: true,
      permissions: permissions(true),
    });
    expect(read).toMatchObject({ allowed: true, trust: "trusted-read" });
    expect(read.capabilities.modifyWorkspace).toBe(false);
    expect(write).toMatchObject({ allowed: true, trust: "trusted-write" });
    expect(write.capabilities).toMatchObject({
      modifyWorkspace: true,
      createPullRequest: true,
      accessNetwork: true,
    });
    expect(deniedTarget).toMatchObject({ allowed: false, trust: "untrusted" });
  });

  it("fails closed for a PR conversation comment until PR origin is resolved", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      isPullRequestTarget: false,
      payload: { comment: { body: "@dsh fix" } },
      pullRequest: undefined,
      isPullRequest: true,
    });
    const unresolved = evaluatePolicy({
      context,
      operation: "fix",
      allowWrite: true,
      permissions: permissions(true),
    });
    const fork = evaluatePolicy({
      context,
      operation: "fix",
      allowWrite: true,
      permissions: permissions(true),
      resolvedPullRequest: { isFork: true },
    });
    const sameRepository = evaluatePolicy({
      context,
      operation: "fix",
      allowWrite: true,
      permissions: permissions(true),
      resolvedPullRequest: { isFork: false },
    });
    expect(unresolved).toMatchObject({ allowed: false, trust: "untrusted" });
    expect(unresolved.reason).toContain("resolves pull request origin");
    expect(fork.allowed).toBe(false);
    expect(sameRepository).toMatchObject({ allowed: true, trust: "trusted-write" });
  });

  it("fails closed for workflow_run write operations even with write opt-in", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      isPullRequestTarget: false,
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [7] },
      entityNumber: undefined,
      isPullRequest: undefined,
      pullRequest: undefined,
    };
    const policy = evaluatePolicy({
      context,
      operation: "fix",
      allowWrite: true,
      permissions: permissions(true),
      resolvedPullRequest: { isFork: false },
    });
    expect(policy).toMatchObject({ allowed: false, trust: "untrusted" });
    expect(policy.reason).toContain("workflow_run");
  });

  it("allows the explicit trusted workflow_run auto-fix route only for a resolved same-repo PR", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      isPullRequestTarget: false,
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [7] },
      entityNumber: undefined,
      isPullRequest: undefined,
      pullRequest: undefined,
    };
    const policy = evaluatePolicy({
      context,
      operation: "fix",
      allowWrite: true,
      allowWorkflowRunWrite: true,
      permissions: permissions(true),
      resolvedPullRequest: { isFork: false },
    });
    expect(policy).toMatchObject({ allowed: true, trust: "trusted-write" });
  });
});
