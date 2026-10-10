import { expect, it, vi } from "vitest";

import { PolicyDeniedError } from "../src/errors.js";
import { issueContentFingerprint } from "../src/github/issue-identity.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { GitHubAuthorityGateway } from "../src/tools/github-authority-gateway.js";
import type { GitHubToolBackend } from "../src/tools/github-backend.js";
import { permissions, pullRequestContext } from "./helpers.js";

it("discards queued GitHub effects when current actor authority changes during validation", async () => {
  const issue = {
    kind: "issue" as const,
    number: 7,
    title: "Issue",
    body: "Body",
    authorId: 1,
    state: "open" as const,
    stateReason: null,
    labels: [],
    assignees: [],
  };
  const unsupported = (): Promise<never> => Promise.reject(new Error("Unexpected transport call"));
  const setLabels = vi.fn(() => Promise.resolve());
  const backend: GitHubToolBackend = {
    getRepository: () => Promise.resolve({ id: 1 }),
    getIssue: () => Promise.resolve(issue),
    setLabels,
    setAssignees: unsupported,
    updateIssueState: unsupported,
    listRecentComments: unsupported,
    createComment: unsupported,
    getPull: unsupported,
    updatePull: unsupported,
    readChecks: unsupported,
  };
  let allowed = true;
  const options = {
    ids: ["github.issue.labels.set"] as const,
    binding: {
      repositoryId: 1,
      owner: "o",
      repo: "r",
      target: "issue" as const,
      entityNumber: 7,
      state: "open" as const,
      updatedAt: "2026-10-10T00:00:00Z",
      contentFingerprint: issueContentFingerprint(issue),
    },
    policy: evaluatePolicy({
      context: pullRequestContext(),
      operation: "fix",
      allowWrite: true,
      permissions: permissions(true),
      commandSource: "automatic-event",
    }),
    allowWrite: true,
    expectedAuthorId: 41898282,
    backend,
    validationGate: () => {
      allowed = false;
      return Promise.resolve();
    },
    revalidateAuthority: () => {
      if (!allowed) throw new PolicyDeniedError("Current actor no longer has write authority");
      return Promise.resolve();
    },
  };
  const gateway = new GitHubAuthorityGateway(options);
  await gateway.invoke(
    { callId: "call-1", id: "github.issue.labels.set", input: { labels: ["triaged"] } },
    { workspacePath: "worker", timeoutMs: 30_000 },
  );
  await expect(gateway.flush({ workspacePath: "worker", timeoutMs: 30_000 })).rejects.toMatchObject(
    { code: "POLICY_DENIED" },
  );
  expect(setLabels).not.toHaveBeenCalled();
  expect(gateway.hasPendingMutations()).toBe(false);
});
