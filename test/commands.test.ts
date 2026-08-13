import { describe, expect, it } from "vitest";
import { parseCommand } from "../src/commands/parse.js";
import { finalizeWorkflowRunRoute, routeCommand } from "../src/commands/router.js";
import { inputs, pullRequestContext } from "./helpers.js";

describe("parseCommand", () => {
  it.each(["review", "diagnose", "fix", "implement"])("parses @dsh %s", (operation) => {
    expect(parseCommand(`@dsh ${operation} check carefully`)).toEqual({
      operation,
      instructions: "check carefully",
    });
  });

  it.each(["please @dsh review", "@dsh", "@dsh shell", "> @dsh fix", "@dsh review\n@dsh fix"])(
    "rejects ambiguous or embedded command: %s",
    (value) => expect(parseCommand(value)).toBeNull(),
  );

  it("normalizes CRLF and accepts case-insensitive commands", () => {
    expect(parseCommand("  @DSH REVIEW focus on races\r\nordinary context")).toEqual({
      operation: "review",
      instructions: "focus on races",
    });
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
        { operation: "review", source: "explicit-input", instructions: "" },
        false,
      ),
    ).toMatchObject({ operation: "review" });
  });

  it("lets explicit trusted inputs select an operation", () => {
    expect(
      routeCommand(pullRequestContext(), inputs({ command: "fix", prompt: "repair" })),
    ).toEqual({ operation: "fix", source: "explicit-input", instructions: "repair" });
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
