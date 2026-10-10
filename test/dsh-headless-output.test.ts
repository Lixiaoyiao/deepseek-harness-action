import { describe, expect, it } from "vitest";

import { decodeHeadlessResult, headlessResultText } from "../src/dsh/headless-output.js";
import { parseDshOutput } from "../src/dsh/schema.js";

const session = { type: "session", sessionId: "session-fixture", cwd: "/workspace" };
const result = {
  protocolVersion: 1,
  operation: "task",
  state: "final",
  summary: "Done",
  findings: [],
};
const terminal = { type: "final", text: JSON.stringify(result) };
const stream = (...events: unknown[]): string =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("DSH headless transport", () => {
  it("keeps unidentifiable or truncated step metadata partial without changing the final result", () => {
    for (const step of [undefined]) {
      const decoded = decodeHeadlessResult(
        stream(
          session,
          {
            type: "status",
            phase: "step_end",
            turn: 0,
            step,
            usage: { inputTokens: 10, outputTokens: 2 },
          },
          terminal,
        ),
      );
      expect(decoded.text).toBe(terminal.text);
      expect(decoded.usage?.completeness).toBe("partial");
    }
    const decoded = decodeHeadlessResult(
      stream(
        session,
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 0,
          truncated: true,
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        terminal,
      ),
    );
    expect(decoded.usage?.completeness).toBe("partial");
  });
  it("retains protocol rejection for unsafe step identifiers", () => {
    expect(() =>
      decodeHeadlessResult(
        stream(
          session,
          {
            type: "status",
            phase: "step_end",
            turn: 0,
            step: Number.MAX_SAFE_INTEGER + 1,
            usage: { inputTokens: 10, outputTokens: 2 },
          },
          terminal,
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "DSH_MALFORMED_OUTPUT" }));
  });
  it("treats contradictory reported token buckets as unknown rather than a complete subtotal", () => {
    for (const usage of [
      { inputTokens: 10, outputTokens: 2, reasoningTokens: 3 },
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30, totalTokens: 20 },
      {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        totalTokens: 43,
      },
    ]) {
      const decoded = decodeHeadlessResult(
        stream(session, { type: "status", phase: "step_end", turn: 0, step: 0, usage }, terminal),
      );
      expect(decoded.text).toBe(terminal.text);
      expect(decoded.usage).toEqual({
        source: "headless-worker",
        completeness: "partial",
        reportedSteps: 0,
        observedSteps: 1,
      });
    }
  });
  it("does not double-count duplicate steps or invent counts from invalid samples", () => {
    const step = {
      type: "status",
      phase: "step_end",
      turn: 0,
      step: 0,
      usage: { inputTokens: 10, outputTokens: 2 },
    };
    const decoded = decodeHeadlessResult(
      stream(
        session,
        step,
        step,
        { ...step, step: 1, usage: { inputTokens: -1, outputTokens: 2 } },
        terminal,
      ),
    );
    expect(decoded.usage).toEqual({
      source: "headless-worker",
      completeness: "partial",
      reportedSteps: 1,
      observedSteps: 2,
      tokens: { inputTokens: 10, outputTokens: 2 },
    });
    expect(decodeHeadlessResult(stream(session, terminal)).usage).toBeUndefined();
  });
  it("marks overflowing token totals unknown instead of publishing imprecise numbers", () => {
    const decoded = decodeHeadlessResult(
      stream(
        session,
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 0,
          usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 2 },
        },
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 1,
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 2,
          usage: { inputTokens: 5, outputTokens: 1 },
        },
        terminal,
      ),
    );
    expect(decoded.usage).toEqual({
      source: "headless-worker",
      completeness: "partial",
      reportedSteps: 3,
      observedSteps: 3,
    });
  });
  it("retains safe uncached/output subtotals when only a cache bucket overflows", () => {
    const decoded = decodeHeadlessResult(
      stream(
        session,
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 0,
          usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: Number.MAX_SAFE_INTEGER },
        },
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 1,
          usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 10 },
        },
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 2,
          usage: { inputTokens: 0, outputTokens: 1, cacheReadTokens: 5 },
        },
        terminal,
      ),
    );
    expect(decoded.usage).toEqual({
      source: "headless-worker",
      completeness: "partial",
      reportedSteps: 3,
      observedSteps: 3,
      tokens: { inputTokens: 0, outputTokens: 3 },
    });
  });
  it("reports the official per-step token buckets once and labels missing samples as partial", () => {
    const decoded = decodeHeadlessResult(
      stream(
        session,
        {
          type: "status",
          phase: "step_end",
          turn: 0,
          step: 0,
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 },
        },
        { type: "status", phase: "step_end", turn: 0, step: 1 },
        terminal,
      ),
    );
    expect(decoded.text).toBe(terminal.text);
    expect(decoded.usage).toMatchObject({
      source: "headless-worker",
      completeness: "partial",
      reportedSteps: 1,
      observedSteps: 2,
      tokens: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 },
    });
  });
  it("rejects escaped credentials in discarded telemetry before lower-priority schema errors", () => {
    for (const event of [
      { type: "thinking", text: "controller-private-key" },
      {
        type: "tool_call",
        callId: "call",
        tool: "fixture",
        input: { secret: "controller-private-key" },
      },
      { type: "unknown", data: "controller-private-key" },
    ]) {
      const raw = stream(session, event, terminal).replace("controller", "\\u0063ontroller");
      expect(() => headlessResultText(raw, ["controller-private-key"])).toThrow(
        expect.objectContaining({ code: "DSH_CREDENTIAL_LEAK" }),
      );
    }
  });
  it("extracts only the lossless final, preserving strict business validation", () => {
    const raw = stream(
      session,
      { type: "status", phase: "turn_start", turn: 0 },
      { type: "thinking", text: "untrusted reasoning" },
      { type: "tool_call", callId: "call-1", tool: "not-controller-authority", input: {} },
      { type: "tool_result", callId: "call-1", status: "completed", result: "untrusted output" },
      { type: "text", text: "truncated answer", truncated: true },
      { type: "status", phase: "turn_end", turn: 0, reason: { kind: "completed" } },
      terminal,
    );
    expect(parseDshOutput(headlessResultText(raw), "task")).toEqual(result);
  });

  it("accepts the official bounded telemetry fallback but never a truncated final", () => {
    expect(
      headlessResultText(stream(session, { type: "tool_call", truncated: true }, terminal)),
    ).toBe(terminal.text);
    expect(() => headlessResultText(stream(session, { ...terminal, truncated: true }))).toThrow();
  });

  it.each([
    [{ type: "unknown" }],
    [{ type: 1 }],
    [terminal],
    [session],
    [session, session, terminal],
    [session, terminal, terminal],
    [session, terminal, { type: "text", text: "after final" }],
    [session, { type: "error", message: "provider failed" }, terminal],
    [session, { type: "unknown" }, terminal],
    [session, { type: "final", text: {}, toolRequest: {} }],
  ])("rejects incomplete, erroneous or ambiguous event streams: %j", (...events) => {
    expect(() => headlessResultText(stream(...events))).toThrow();
  });

  it("rejects mixed prose and events instead of searching for a JSON substring", () => {
    expect(() => headlessResultText(`prefix\n${stream(session, terminal)}`)).toThrow();
    expect(() =>
      headlessResultText(`${stream(session)}broken JSON\n${stream(terminal)}`),
    ).toThrow();
  });

  it("does not grant business authority to a valid final envelope", () => {
    for (const invalid of [
      "Done",
      JSON.stringify({ ...result, operation: "fix" }),
      JSON.stringify({ ...result, unknown: true }),
      JSON.stringify({ ...result, toolRequest: { id: "github.comment" } }),
    ]) {
      const raw = stream(session, { type: "final", text: invalid });
      expect(() => parseDshOutput(headlessResultText(raw), "task")).toThrow();
    }
  });

  it("retains the published text mode for host launcher compatibility", () => {
    expect(headlessResultText(JSON.stringify(result, null, 2))).toBe(
      JSON.stringify(result, null, 2),
    );
    expect(headlessResultText("malformed terminal text")).toBe("malformed terminal text");
  });
});
