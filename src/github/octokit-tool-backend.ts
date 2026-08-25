import type { GitHubClient } from "./client.js";
import type { GitHubBackendRequestControl, GitHubToolBackend } from "../tools/github-backend.js";

function request(control: GitHubBackendRequestControl) {
  return { request: { timeout: control.timeoutMs, signal: control.signal } } as const;
}

/** The sole production backend for Action-owned `github.*` capabilities. */
export function createOctokitGitHubToolBackend(client: GitHubClient): GitHubToolBackend {
  return {
    async getRepository(target, control) {
      const response = await client.rest.repos.get({
        owner: target.owner,
        repo: target.repo,
        ...request(control),
      });
      return { id: response.data.id };
    },
    async getIssue(target, control) {
      const response = await client.rest.issues.get({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        ...request(control),
      });
      return {
        kind: "pull_request" in response.data ? "pull_request" : "issue",
        number: response.data.number,
        title: response.data.title,
        body: response.data.body ?? null,
        authorId: response.data.user?.id ?? null,
        labels: response.data.labels.flatMap((label) =>
          typeof label === "string" ? [label] : label.name === undefined ? [] : [label.name],
        ),
        assignees: (response.data.assignees ?? []).map(({ login }) => login),
        state: response.data.state === "closed" ? "closed" : "open",
        stateReason:
          response.data.state_reason === "completed" ||
          response.data.state_reason === "not_planned" ||
          response.data.state_reason === "reopened"
            ? response.data.state_reason
            : null,
      };
    },
    async setLabels(target, labels, control) {
      await client.rest.issues.setLabels({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        labels: [...labels],
        ...request(control),
      });
    },
    async setAssignees(target, assignees, control) {
      await client.rest.issues.update({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        assignees: [...assignees],
        ...request(control),
      });
    },
    async updateIssueState(target, input, control) {
      await client.rest.issues.update({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        state: input.state,
        ...(input.stateReason === undefined ? {} : { state_reason: input.stateReason }),
        ...request(control),
      });
    },
    async listRecentComments(target, control) {
      const response = await client.rest.issues.listComments({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        per_page: 100,
        sort: "created",
        direction: "desc",
        ...request(control),
      });
      return response.data.slice(0, 100).map((comment) => ({
        id: comment.id,
        body: comment.body ?? "",
        authorId: comment.user?.id ?? null,
      }));
    },
    async createComment(target, body, control) {
      await client.rest.issues.createComment({
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        body,
        ...request(control),
      });
    },
    async getPull(target, control) {
      const response = await client.rest.pulls.get({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pullNumber,
        ...request(control),
      });
      const headRepository = response.data.head.repo as { readonly id: number } | null;
      return {
        number: response.data.number,
        title: response.data.title,
        body: response.data.body ?? "",
        state: response.data.state === "closed" ? "closed" : "open",
        maintainerCanModify: response.data.maintainer_can_modify,
        headSha: response.data.head.sha,
        headRef: response.data.head.ref,
        headRepositoryId: headRepository?.id ?? null,
        baseSha: response.data.base.sha,
        baseRef: response.data.base.ref,
        baseRepositoryId: response.data.base.repo.id,
      };
    },
    async updatePull(target, input, control) {
      await client.rest.pulls.update({
        owner: target.owner,
        repo: target.repo,
        pull_number: target.pullNumber,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.maintainerCanModify === undefined
          ? {}
          : { maintainer_can_modify: input.maintainerCanModify }),
        ...request(control),
      });
    },
    async readChecks(target, control) {
      const [checks, statuses] = await Promise.all([
        client.rest.checks.listForRef({
          owner: target.owner,
          repo: target.repo,
          ref: target.headSha,
          per_page: 50,
          page: 1,
          ...request(control),
        }),
        client.rest.repos.getCombinedStatusForRef({
          owner: target.owner,
          repo: target.repo,
          ref: target.headSha,
          per_page: 50,
          page: 1,
          ...request(control),
        }),
      ]);
      return {
        totalCount: checks.data.total_count,
        statusCount: statuses.data.total_count,
        checkRuns: checks.data.check_runs.slice(0, 50).map((check) => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
        })),
        combinedState: statuses.data.state,
        statuses: statuses.data.statuses.slice(0, 50).map((status) => ({
          context: status.context,
          state: status.state,
          description: status.description ?? "",
        })),
      };
    },
  };
}
