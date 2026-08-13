/* Derived in part from anthropics/claude-code-action tests, MIT licensed. */
import { describe, expect, it } from "vitest";
import { parseGitHubContext } from "../src/github/context.js";

const pr = {
  number: 42,
  head: { sha: "a".repeat(40), ref: "topic", repo: { id: 2, full_name: "fork/repo" } },
  base: { sha: "b".repeat(40), ref: "main", repo: { id: 1, full_name: "octo/repo" } },
};

const base = {
  action: "opened",
  repository: {
    id: 1,
    name: "repo",
    full_name: "octo/repo",
    default_branch: "main",
    owner: { login: "octo" },
  },
  sender: { login: "alice" },
};

describe("parseGitHubContext", () => {
  it("keeps pull_request_target raw provenance while normalizing semantics", () => {
    const context = parseGitHubContext(
      { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_ACTOR: "alice" },
      { ...base, pull_request: pr },
    );
    expect(context.rawEventName).toBe("pull_request_target");
    expect(context.eventName).toBe("pull_request");
    expect(context.isPullRequestTarget).toBe(true);
    expect(context.kind === "entity" && context.pullRequest?.isFork).toBe(true);
  });

  it("classifies issue comments on pull requests", () => {
    const context = parseGitHubContext(
      { GITHUB_EVENT_NAME: "issue_comment" },
      { ...base, issue: { number: 4, pull_request: { url: "example" } } },
    );
    expect(context.kind).toBe("entity");
    expect(context.kind === "entity" && context.isPullRequest).toBe(true);
  });

  it("captures every workflow_run actor for later permission checks", () => {
    const context = parseGitHubContext(
      { GITHUB_EVENT_NAME: "workflow_run", GITHUB_ACTOR: "receiver" },
      {
        ...base,
        action: "completed",
        workflow_run: {
          id: 9,
          head_sha: "c".repeat(40),
          actor: { login: "originator" },
          triggering_actor: { login: "rerunner" },
          pull_requests: [{ number: 8 }],
        },
      },
    );
    expect(context.kind === "automation" && context.workflowRun).toMatchObject({
      actor: "originator",
      triggeringActor: "rerunner",
      pullRequestNumbers: [8],
    });
  });

  it("rejects repository mismatches and malformed payloads", () => {
    expect(() =>
      parseGitHubContext(
        { GITHUB_EVENT_NAME: "issues", GITHUB_REPOSITORY: "attacker/repo" },
        { ...base, issue: { number: 1 } },
      ),
    ).toThrow(/does not match/u);
    expect(() => parseGitHubContext({ GITHUB_EVENT_NAME: "issues" }, {})).toThrow(
      /Invalid GitHub event payload/u,
    );
  });
});
