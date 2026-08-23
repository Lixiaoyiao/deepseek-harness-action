import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands/parse.js";
import { finalizeWorkflowRunRoute, routeCommand } from "../src/commands/router.js";
import { inputs, pullRequestContext } from "./helpers.js";

describe("parseCommand", () => {
  it.each(["review", "diagnose", "fix", "implement"])("parses @dsh %s", (operation) => {
    expect(parseCommand(`@dsh ${operation} check carefully`)).toEqual({
      operation,
      instructions: "check carefully",
      requestedAccess: operation === "fix" || operation === "implement" ? "write" : "read",
    });
  });

  it.each(["please @dsh review", "@dsh", "@dsh shell", "> @dsh fix", "@dsh review\n@dsh fix"])(
    "rejects ambiguous or embedded command: %s",
    (value) => expect(parseCommand(value)).toBeNull(),
  );

  it("normalizes CRLF and accepts case-insensitive commands", () => {
    expect(parseCommand("  @DSH REVIEW focus on races\r\nordinary context")).toEqual({
      operation: "review",
      instructions: "focus on races\nordinary context",
      requestedAccess: "read",
    });
  });

  it("treats a custom trigger phrase literally while preserving first-line grammar", () => {
    expect(parseCommand("  /dsh+ review focus", "/dsh+")).toEqual({
      operation: "review",
      instructions: "focus",
      requestedAccess: "read",
    });
    expect(parseCommand("please /dsh+ review", "/dsh+")).toBeNull();
    expect(parseCommand("/dsh+ review\n/dsh+ fix", "/dsh+")).toBeNull();
    expect(parseCommand("@dsh review", "/dsh+")).toBeNull();
  });

  it("parses generic task intent with explicit access and multiline instructions", () => {
    expect(parseCommand("@dsh task explain the cache")).toEqual({
      operation: "task",
      instructions: "explain the cache",
      requestedAccess: "read",
    });
    expect(parseCommand("@dsh task --write repair the cache\nthen update its test")).toEqual({
      operation: "task",
      instructions: "repair the cache\nthen update its test",
      requestedAccess: "write",
    });
    expect(parseCommand("@dsh task --unknown do it")).toBeNull();
    expect(parseCommand("@dsh task")).toBeNull();
  });
});

describe("routeCommand", () => {
  it("automatically reviews supported pull request actions", () => {
    expect(routeCommand(pullRequestContext(), inputs())).toMatchObject({
      operation: "review",
      source: "automatic-event",
    });
  });

  it("takes commands only from the triggering comment field", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: { comment: { body: "@dsh diagnose now" }, repositoryReadme: "@dsh fix" },
    });
    expect(routeCommand(context, inputs())).toEqual({
      operation: "diagnose",
      source: "mention",
      instructions: "now",
      requestedAccess: "read",
    });
  });

  it("uses the configured trigger phrase without broadening comment parsing", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: { comment: { body: "/deepseek diagnose now" } },
    });
    expect(routeCommand(context, inputs({ triggerPhrase: "/deepseek" }))).toMatchObject({
      operation: "diagnose",
      source: "mention",
      instructions: "now",
    });
    expect(routeCommand(context, inputs())).toBeNull();
  });

  it("keeps GitHub image sources out of trusted mention instructions", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: {
        comment: {
          body: "@dsh task --read inspect this\n![upload](https://github.com/user-attachments/assets/secret)",
        },
      },
    });
    expect(routeCommand(context, inputs())).toMatchObject({
      operation: "task",
      instructions: "inspect this\n[image removed]",
      source: "mention",
    });
  });

  it("removes reference, HTML, and raw attachment sources from command instructions", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: {
        comment: {
          body: [
            "@dsh task --read inspect these",
            "![upload][attachment]",
            "[attachment]: https://github.com/user-attachments/assets/example?token=secret",
            '<picture><source srcset="https://example.test/a"><img src="https://example.test/b"></picture>',
            "raw https://user-images.githubusercontent.com/1/example.png?sig=secret",
          ].join("\n"),
        },
      },
    });
    const routed = routeCommand(context, inputs());
    expect(routed?.instructions).not.toContain("user-attachments");
    expect(routed?.instructions).not.toContain("example.test");
    expect(routed?.instructions).not.toContain("user-images.githubusercontent.com");
    expect(routed?.instructions).toContain("[image removed]");
  });

  it("applies the same text-only boundary to configured prompts", () => {
    const routed = routeCommand(
      pullRequestContext(),
      inputs({
        command: "review",
        prompt:
          'inspect <img src="https://example.test/private.png"> and https://github.com/user-attachments/assets/example?token=secret',
      }),
    );
    expect(routed?.instructions).toBe("inspect [image removed] and [image removed]");
  });

  it("routes maintainer-configured label and assignee events by entity kind", () => {
    const issue = pullRequestContext({
      rawEventName: "issues",
      eventName: "issues",
      eventAction: "labeled",
      isPullRequest: false,
      pullRequest: undefined,
      payload: { label: { name: "dsh-ready" } },
    });
    expect(
      routeCommand(
        issue,
        inputs({ labelTrigger: "DSH-READY", taskAccess: "write", prompt: "handle issue" }),
      ),
    ).toEqual({
      operation: "task",
      source: "automatic-event",
      instructions: "handle issue",
      requestedAccess: "write",
    });

    const pull = pullRequestContext({
      eventAction: "assigned",
      payload: { assignee: { login: "review-bot" } },
    });
    expect(
      routeCommand(pull, inputs({ assigneeTrigger: "@Review-Bot", taskAccess: "write" })),
    ).toEqual({
      operation: "review",
      source: "automatic-event",
      instructions: "",
      requestedAccess: "read",
    });
    expect(routeCommand(issue, inputs({ labelTrigger: "other" }))).toBeNull();
  });

  it("applies allowed-actors only as a routing filter", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      actor: "outsider",
      payload: { comment: { body: "@dsh review" } },
    });
    expect(routeCommand(context, inputs({ allowedActors: ["maintainer"] }))).toBeNull();
    expect(routeCommand(context, inputs({ allowedActors: ["*"] }))).toMatchObject({
      operation: "review",
      source: "mention",
    });
  });

  it.each([
    ["pull_request_review", { review: { body: "@dsh review" } }],
    ["pull_request_review_comment", { comment: { body: "@dsh diagnose" } }],
  ] as const)("routes %s trigger bodies", (eventName, payload) => {
    expect(
      routeCommand(pullRequestContext({ rawEventName: eventName, eventName, payload }), inputs()),
    ).toMatchObject({ source: "mention" });
  });

  it("ignores unsupported PR actions and unrelated comments", () => {
    expect(routeCommand(pullRequestContext({ eventAction: "closed" }), inputs())).toBeNull();
    expect(
      routeCommand(
        pullRequestContext({
          rawEventName: "issue_comment",
          eventName: "issue_comment",
          payload: { comment: { body: "ordinary discussion" } },
        }),
        inputs(),
      ),
    ).toBeNull();
  });

  it("routes read-only workflow failures to diagnosis", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [] },
    };
    expect(routeCommand(context, inputs())).toMatchObject({ operation: "diagnose" });
    expect(
      finalizeWorkflowRunRoute(
        context,
        {
          operation: "review",
          source: "explicit-input",
          instructions: "",
          requestedAccess: "read",
        },
        false,
      ),
    ).toMatchObject({ operation: "review" });
  });

  it("lets explicit trusted inputs select an operation", () => {
    expect(
      routeCommand(pullRequestContext(), inputs({ command: "fix", prompt: "repair" })),
    ).toEqual({
      operation: "fix",
      source: "explicit-input",
      instructions: "repair",
      requestedAccess: "write",
    });
  });

  it("routes a non-empty automation prompt into generic task mode", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_dispatch" as const,
      eventName: "workflow_dispatch" as const,
      eventAction: "requested",
    };
    expect(
      routeCommand(
        context,
        inputs({ command: "auto", prompt: "upgrade dependencies", taskAccess: "write" }),
      ),
    ).toEqual({
      operation: "task",
      source: "explicit-prompt",
      instructions: "upgrade dependencies",
      requestedAccess: "write",
    });
  });

  it("routes a failed workflow run to opt-in auto-fix when write is enabled", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [7] },
    };
    expect(routeCommand(context, inputs({ allowWrite: true }))).toMatchObject({
      operation: "fix",
      source: "automatic-event",
    });
  });

  it("downgrades automatic workflow_run fix to diagnosis when no PR resolves", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [] },
    };
    const routed = routeCommand(context, inputs({ allowWrite: true }));
    if (routed === null) throw new Error("Expected workflow_run to be routed");
    expect(finalizeWorkflowRunRoute(context, routed, false)).toMatchObject({
      operation: "diagnose",
      source: "automatic-event",
    });
  });

  it("keeps automatic workflow_run fix when a PR resolves", () => {
    const base = pullRequestContext();
    const context = {
      ...base,
      kind: "automation" as const,
      rawEventName: "workflow_run" as const,
      eventName: "workflow_run" as const,
      eventAction: "completed",
      workflowRun: { id: 1, headSha: "a".repeat(40), pullRequestNumbers: [7] },
    };
    const routed = routeCommand(context, inputs({ allowWrite: true }));
    if (routed === null) throw new Error("Expected workflow_run to be routed");
    expect(finalizeWorkflowRunRoute(context, routed, true)).toMatchObject({ operation: "fix" });
  });
});
